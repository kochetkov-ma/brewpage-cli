import { createServer } from "node:http";

export const LINK = "https://brewpage.app/x7k2m9/a1b2c3d4e5";
export const MANAGE_URL = "https://brewpage.app/x7k2m9/a1b2c3d4e5#k=stub-manage-key-0123456789";
export const MANAGEMENT_LINK = "https://brewpage.app/manage/x7k2m9/a1b2c3d4e5";
export const OWNER_TOKEN = "stub-owner-token-0123456789";
export const EXPIRES_AT = "2026-12-05T10:00:00Z";

export const LIMITS = Object.freeze({
  requestMaxBytes: 52_428_800,
  html: { defaultTtlDays: 15, maxBytes: 5_242_880, maxTtlDays: 30 },
  files: { defaultTtlDays: 15, maxFileBytes: 10_485_760, maxVideoBytes: 52_428_800, maxAudioBytes: 20_971_520, maxTtlDays: 30, maxFiles: 100 },
});

/** 200 publish answer as the API sends it; `extra` overrides fields. */
export function published(extra = {}) {
  return {
    status: 200,
    headers: {},
    body: {
      link: LINK, manageUrl: MANAGE_URL, managementLink: MANAGEMENT_LINK, ownerToken: OWNER_TOKEN,
      expiresAt: EXPIRES_AT, namespace: "x7k2m9", id: "a1b2c3d4e5", access: "unlisted", ...extra,
    },
  };
}

/** Error answer in the API's ErrorResponse shape. */
export function failed(status, error, message, extra = {}, headers = {}) {
  return { status, headers, body: { error, message, status, timestamp: "2026-11-20T10:00:00Z", ...extra } };
}

/** Stub API on 127.0.0.1:0: records every request; /api/limits answers `limits`, other paths `reply`. */
export async function startStub({ limits = LIMITS, reply = published() } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    const answer = req.url === "/api/limits" ? { status: 200, headers: {}, body: limits } : reply;
    res.writeHead(answer.status, { "Content-Type": "application/json", ...answer.headers });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

/** Comparable view of a recorded request: multipart bodies become their parts, other bodies stay bytes. */
export async function summarize({ method, url, headers, body }) {
  const type = headers["content-type"]?.split(";")[0] ?? null;
  const form = type === "multipart/form-data"
    ? await new Response(body, { headers: { "content-type": headers["content-type"] } }).formData()
    : null;
  const parts = form === null ? body : Object.fromEntries(await Promise.all([...form.entries()].map(async ([name, file]) => [
    name, { name: file.name, type: file.type, content: Buffer.from(await file.arrayBuffer()) },
  ])));
  return { method, path: url, type, body: parts };
}
