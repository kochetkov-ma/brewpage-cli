import { openAsBlob, readFileSync } from "node:fs";
import { basename, extname } from "node:path";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export const DEFAULT_URL = "https://brewpage.app";
export const EXIT = Object.freeze({
  OK: 0, UNEXPECTED: 1, USAGE: 2, REFUSED: 3, TOO_LARGE: 4, NETWORK: 5, RATE_LIMITED: 6, NOT_SAVED: 7,
});

const LIMITS_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 300_000;
const REFUSED = new Set([400, 403, 404, 409, 415, 422]);
const TOO_LARGE = /exceeds maximum size|too large|too big|allow at most/i;
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;
// Ambiguous containers (ogg, webm) take the video cap: the local check never refuses what the server takes.
const VIDEO = new Set(["mp4", "m4v", "mov", "mkv", "avi", "webm", "ogv", "ogg"]);
const AUDIO = new Set(["mp3", "wav", "m4a", "aac", "flac", "opus", "weba", "oga"]);
const TEXT = {
  html: { type: "text/html", format: "html" },
  markdown: { type: "text/markdown", format: "markdown" },
  text: { type: "text/plain", format: "txt" },
};

/** Failure with the exit code it maps to; `details` are extra stderr lines. */
export class CliError extends Error {
  constructor(exitCode, message, details = []) {
    super(message);
    this.exitCode = exitCode;
    this.details = details;
  }
}

/** Control characters out of server text before it reaches a terminal. */
export function clean(text) {
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
}

/** Human size: MB from 1 MiB, else bytes; `digits` lets callers tell close sizes apart. */
export function mb(bytes, digits = 1) {
  if (bytes < 1_048_576) return `${bytes} bytes`;
  return `${(bytes / 1_048_576).toFixed(digits).replace(/\.?0+$/, "")} MB`;
}

/** "<size>; <kind> may be at most <cap>" with enough digits that size and cap differ. */
export function overText(size, cap, kind) {
  const digits = [1, 2, 3].find((d) => mb(size, d) !== mb(cap, d)) ?? 3;
  const shown = mb(size, digits) === mb(cap, digits) ? `${size} bytes` : mb(size, digits);
  return `${shown}; ${kind} may be at most ${mb(cap)}`;
}

/** Client markers sent on every request. */
export function clientHeaders() {
  return { "User-Agent": `brewpage-cli/${VERSION}`, "X-BrewPage-Client": `cli/${VERSION}` };
}

/** API base from BREWPAGE_URL: https only, http only on loopback; no credentials, query or fragment. */
export function baseUrl(raw) {
  const text = raw === undefined || raw === "" ? DEFAULT_URL : raw;
  if (!URL.canParse(text)) throw new CliError(EXIT.USAGE, "BREWPAGE_URL is not a valid URL.");
  const url = new URL(text);
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.test(url.hostname));
  if (!secure) throw new CliError(EXIT.USAGE, "BREWPAGE_URL must use https (http only for localhost).");
  if (url.username || url.password || url.search || url.hash) {
    throw new CliError(EXIT.USAGE, "BREWPAGE_URL must not carry credentials, a query or a fragment.");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function networkMessage(error, base) {
  const host = URL.canParse(base) ? new URL(base).host : base;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return `${host} did not answer in time.`;
  const code = error?.cause?.code ?? error?.code ?? error?.cause?.message;
  return `Could not reach ${host}${code ? ` (${code})` : ""}.`;
}

async function send(base, path, init, timeoutMs) {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...clientHeaders(), Accept: "application/json", ...init.headers },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new CliError(EXIT.NETWORK, networkMessage(error, base));
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw new CliError(EXIT.NETWORK, `Refused a redirect (HTTP ${res.status}); check BREWPAGE_URL.`);
  }
  return res;
}

function query(params) {
  const search = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined).map(([k, v]) => [k, String(v)]));
  const text = search.toString();
  return text ? `?${text}` : "";
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/** GET /api/limits; anything unreadable is exit 5, since no upload may run without it. */
export async function getLimits(base) {
  const res = await send(base, "/api/limits", { method: "GET" }, LIMITS_TIMEOUT_MS);
  const data = await res.json().catch(() => null);
  const usable = res.ok && positive(data?.requestMaxBytes) && positive(data?.html?.maxBytes) && positive(data?.html?.maxTtlDays)
    && positive(data?.files?.maxFileBytes) && positive(data?.files?.maxVideoBytes) && positive(data?.files?.maxAudioBytes)
    && positive(data?.files?.maxTtlDays);
  if (!usable) throw new CliError(EXIT.NETWORK, `Could not read the upload limits (HTTP ${res.status}); try again later.`);
  return data;
}

/** Size cap for a file by its extension, never above the request cap. */
export function fileLimit(limits, name) {
  const ext = extname(name).slice(1).toLowerCase();
  const [kind, cap] = VIDEO.has(ext) ? ["videos", limits.files.maxVideoBytes]
    : AUDIO.has(ext) ? ["audio files", limits.files.maxAudioBytes] : ["files", limits.files.maxFileBytes];
  return { kind, maxBytes: Math.min(cap, limits.requestMaxBytes) };
}

/** Size cap for text sent from stdin as a page. */
export function textLimit(limits) {
  return { kind: "pages", maxBytes: Math.min(limits.html.maxBytes, limits.requestMaxBytes) };
}

function retryAfter(res, data) {
  if (res.status !== 429 && res.status !== 503) return undefined;
  const header = res.headers.get("retry-after")?.trim();
  if (header && /^\d+$/.test(header)) return `Retry after ${Number(header)} seconds.`;
  if (Number.isSafeInteger(data?.retryAfterSeconds)) return `Retry after ${data.retryAfterSeconds} seconds.`;
  return header ? `Retry after ${clean(header)}.` : undefined;
}

function exitFor(status, message) {
  if (status === 413 || (status === 400 && TOO_LARGE.test(message))) return EXIT.TOO_LARGE;
  if (status === 429) return EXIT.RATE_LIMITED;
  if (status === 408 || status >= 500) return EXIT.NETWORK;
  return REFUSED.has(status) ? EXIT.REFUSED : EXIT.UNEXPECTED;
}

async function answer(res) {
  let text;
  try {
    text = await res.text();
  } catch {
    throw new CliError(EXIT.NETWORK, "The answer was cut off; the publication may exist without its link.");
  }
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  if (res.ok) {
    if (typeof data?.link !== "string" || !/^https?:\/\/[^\s\u0000-\u001f\u007f-\u009f]+$/.test(data.link)) {
      throw new CliError(EXIT.UNEXPECTED, `Unexpected answer without a link (HTTP ${res.status}).`);
    }
    return data;
  }
  const message = typeof data?.message === "string" && data.message ? clean(data.message) : `HTTP ${res.status}`;
  const details = [];
  if (Array.isArray(data?.supportedTypes)) details.push(`Supported types: ${clean(data.supportedTypes.join(", "))}`);
  const after = retryAfter(res, data);
  if (after) details.push(after);
  if (res.status === 429 && typeof data?.accountUrl === "string") details.push(`Higher limits with a free account: ${clean(data.accountUrl)}`);
  throw new CliError(exitFor(res.status, message), message, details);
}

/** POST /api/files: multipart field `file`, basename only. */
export async function publishFile(base, { path, ns, ttl, format }) {
  const form = new FormData();
  form.append("file", await openAsBlob(path), basename(path));
  const res = await send(base, `/api/files${query({ ns, ttl, format: TEXT[format]?.format })}`, { method: "POST", body: form }, UPLOAD_TIMEOUT_MS);
  return answer(res);
}

/** POST /api/html raw body: text/plain without `format` (server picks), else its type plus `format=`. */
export async function publishText(base, { body, ns, ttl, format }) {
  const chosen = TEXT[format];
  const res = await send(base, `/api/html${query({ ns, ttl, format: chosen?.format })}`, {
    method: "POST", headers: { "Content-Type": chosen?.type ?? "text/plain" }, body,
  }, UPLOAD_TIMEOUT_MS);
  return answer(res);
}
