import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { main } from "../src/cli.js";
import {
  EXPIRES_AT, LIMITS, LINK, MANAGEMENT_LINK, MANAGE_URL, OWNER_TOKEN, failed, published, startStub, summarize,
} from "./stub.js";

const VERSION = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const MARKERS = { ua: `brewpage-cli/${VERSION}`, client: `cli/${VERSION}` };
const PRIVATE = [OWNER_TOKEN, MANAGE_URL, MANAGEMENT_LINK];
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const RECORD = { link: LINK, manageUrl: MANAGE_URL, ownerToken: OWNER_TOKEN, expiresAt: EXPIRES_AT, namespace: "x7k2m9", id: "a1b2c3d4e5", access: "unlisted" };

const LIMITS_GET = { method: "GET", path: "/api/limits", type: null, body: Buffer.alloc(0) };
const filePost = (path, name, content) => ({
  method: "POST", path, type: "multipart/form-data",
  body: { file: { name, type: "application/octet-stream", content: Buffer.from(content) } },
});
const textPost = (path, type, content) => ({ method: "POST", path, type, body: Buffer.from(content) });

const NOTHING_SAVED = { dir: "absent", file: "absent", lines: [] };
const saved = (record = RECORD) => ({ dir: "700", file: "600", lines: [record] });
const usage = (message) => `brewpage: ${message}\nRun \`brewpage --help\` for usage.\n`;
const shown = (access = "unlisted") => `Expires: ${EXPIRES_AT}\nAccess: ${access}\n`;
const receiptLine = (ctx) => `Receipt: ${ctx.receipts} (private: management link and owner token)\n`;
const privateLines = `PRIVATE management link (edit or delete; keep it secret): ${MANAGE_URL}\n`
  + `PRIVATE owner token (keep it secret): ${OWNER_TOKEN}\n`;
const TOKEN_NOTICE = {
  code: "owner-token-new",
  message: "New ownerToken: keep it; send it as X-Owner-Token on later publishes and updates. "
    + "Give the user link and manageUrl (private: it edits or deletes this publication).",
};
const savedLine = (ctx) => `Saved your owner token and management link to ${ctx.receipts}; keep that file private.\n`;

const row = (name, spec) => ({
  files: {}, stdin: () => Readable.from([]), stub: {}, setup: async () => undefined,
  pick: (observed) => observed, ...spec, name,
});

const ROWS = [
  row("GIVEN an html file WHEN published THEN it is uploaded as multipart by basename and stdout is only the link", {
    files: { "page.html": "<h1>Hi</h1>\n" },
    argv: (ctx) => [ctx.path("page.html")],
    expected: (ctx) => ({
      code: 0, stdout: `${LINK}\n`, stderr: shown() + receiptLine(ctx),
      requests: [LIMITS_GET, filePost("/api/files", "page.html", "<h1>Hi</h1>\n")], receipt: saved(),
    }),
  }),
  row("GIVEN a markdown file WHEN the server publishes it as a page THEN its notice goes to stderr", {
    files: { "notes.md": "# Notes\n" },
    stub: { reply: published({ notices: [{ code: "markdown-file-as-page", message: `This Markdown file was published as a page at ${LINK}` }] }) },
    argv: (ctx) => ["publish", ctx.path("notes.md")],
    expected: (ctx) => ({
      code: 0, stdout: `${LINK}\n`,
      stderr: `${shown()}Notice: This Markdown file was published as a page at ${LINK}\n${receiptLine(ctx)}`,
      requests: [LIMITS_GET, filePost("/api/files", "notes.md", "# Notes\n")], receipt: saved(),
    }),
  }),
  row("GIVEN a new-owner-token notice and an unknown notice WHEN published THEN the token one becomes the saved line and the unknown one passes unchanged", {
    files: { "page.html": "<p>Token</p>" },
    stub: { reply: published({ notices: [TOKEN_NOTICE, { code: "future-advice", message: "Something new from the server." }] }) },
    argv: (ctx) => [ctx.path("page.html")],
    expected: (ctx) => ({
      code: 0, stdout: `${LINK}\n`, stderr: `${shown()}Notice: Something new from the server.\n${savedLine(ctx)}`,
      requests: [LIMITS_GET, filePost("/api/files", "page.html", "<p>Token</p>")], receipt: saved(),
    }),
  }),
  row("GIVEN a new-owner-token notice and --no-save WHEN published THEN only the edit-and-delete-lost warning stands in for it", {
    stdin: () => Readable.from([Buffer.from("no receipt\n")]),
    stub: { reply: published({ notices: [TOKEN_NOTICE] }) },
    argv: () => ["-", "--no-save"],
    expected: () => ({
      code: 0, stdout: `${LINK}\n`, stderr: `${shown()}Not saved (--no-save): you cannot edit or delete this publication later.\n`,
      requests: [LIMITS_GET, textPost("/api/html", "text/plain", "no receipt\n")], receipt: NOTHING_SAVED,
    }),
  }),
  row("GIVEN a new-owner-token notice and an unwritable receipts dir WHEN published THEN it claims no save and exits 7 with PRIVATE lines", {
    files: { "page.html": "<p>Unsaved</p>" },
    stub: { reply: published({ notices: [TOKEN_NOTICE] }) },
    setup: async (ctx) => {
      await mkdir(ctx.state);
      await chmod(ctx.state, 0o500);
    },
    argv: (ctx) => [ctx.path("page.html")],
    expected: (ctx) => ({
      code: 7, stdout: `${LINK}\n`,
      stderr: `${shown()}brewpage: could not save the receipt at ${ctx.receipts}: EACCES.\n${privateLines}`,
      requests: [LIMITS_GET, filePost("/api/files", "page.html", "<p>Unsaved</p>")],
      receipt: { dir: "500", file: "absent", lines: [] },
    }),
  }),
  row("GIVEN a png file WHEN published THEN its bytes are uploaded unchanged", {
    files: { "pic.png": PNG },
    argv: (ctx) => [ctx.path("pic.png")],
    expected: (ctx) => ({
      code: 0, stdout: `${LINK}\n`, stderr: shown() + receiptLine(ctx),
      requests: [LIMITS_GET, filePost("/api/files", "pic.png", PNG)], receipt: saved(),
    }),
  }),
  row("GIVEN piped stdin and no format WHEN published THEN it is sent as text/plain without format", {
    stdin: () => Readable.from([Buffer.from("hello from a pipe\n")]),
    argv: () => [],
    expected: (ctx) => ({
      code: 0, stdout: `${LINK}\n`, stderr: shown() + receiptLine(ctx),
      requests: [LIMITS_GET, textPost("/api/html", "text/plain", "hello from a pipe\n")], receipt: saved(),
    }),
  }),
  row("GIVEN piped stdin and --format markdown WHEN published THEN it is sent as text/markdown with format=markdown", {
    stdin: () => Readable.from([Buffer.from("# Title\n")]),
    argv: () => ["-", "--format", "markdown"],
    expected: (ctx) => ({
      code: 0, stdout: `${LINK}\n`, stderr: shown() + receiptLine(ctx),
      requests: [LIMITS_GET, textPost("/api/html?format=markdown", "text/markdown", "# Title\n")], receipt: saved(),
    }),
  }),
  row("GIVEN --public WHEN a file is published THEN the upload carries ns=public", {
    files: { "page.html": "<p>Public</p>" },
    stub: { reply: published({ namespace: "public", access: "public" }) },
    argv: (ctx) => [ctx.path("page.html"), "--public"],
    expected: (ctx) => ({
      code: 0, stdout: `${LINK}\n`, stderr: shown("public") + receiptLine(ctx),
      requests: [LIMITS_GET, filePost("/api/files?ns=public", "page.html", "<p>Public</p>")],
      receipt: saved({ ...RECORD, namespace: "public", access: "public" }),
    }),
  }),
  row("GIVEN --ttl 7 WHEN stdin is published THEN the request carries ttl=7", {
    stdin: () => Readable.from([Buffer.from("seven days\n")]),
    argv: () => ["publish", "-", "--ttl", "7"],
    expected: (ctx) => ({
      code: 0, stdout: `${LINK}\n`, stderr: shown() + receiptLine(ctx),
      requests: [LIMITS_GET, textPost("/api/html?ttl=7", "text/plain", "seven days\n")], receipt: saved(),
    }),
  }),
  row("GIVEN --ttl over the server maximum WHEN run THEN it exits 2 without any POST", {
    files: { "page.html": "<p>Long</p>" },
    argv: (ctx) => [ctx.path("page.html"), "--ttl", "31"],
    expected: () => ({
      code: 2, stdout: "", stderr: usage("--ttl may be at most 30 days."), requests: [LIMITS_GET], receipt: NOTHING_SAVED,
    }),
  }),
  row("GIVEN a file over the server file limit WHEN run THEN it exits 4 without any POST", {
    files: { "big.bin": "x".repeat(17) },
    stub: { limits: { ...LIMITS, files: { ...LIMITS.files, maxFileBytes: 16 } } },
    argv: (ctx) => [ctx.path("big.bin")],
    expected: () => ({
      code: 4, stdout: "", stderr: "brewpage: big.bin is 17 bytes; files may be at most 16 bytes.\n",
      requests: [LIMITS_GET], receipt: NOTHING_SAVED,
    }),
  }),
  row("GIVEN the server answers 413 WHEN a file is published THEN it exits 4", {
    files: { "page.html": "<p>Big</p>" },
    stub: { reply: failed(413, "Payload Too Large", "Maximum upload size exceeded") },
    argv: (ctx) => [ctx.path("page.html")],
    expected: () => ({
      code: 4, stdout: "", stderr: "brewpage: Maximum upload size exceeded\n",
      requests: [LIMITS_GET, filePost("/api/files", "page.html", "<p>Big</p>")], receipt: NOTHING_SAVED,
    }),
  }),
  row("GIVEN the server answers 422 WHEN a file is published THEN it exits 3 and lists the supported types", {
    files: { "tool.exe": "MZ" },
    stub: {
      reply: failed(422, "Unprocessable Entity", "File type application/x-msdownload is not supported",
        { supportedTypes: ["image/png", "application/pdf", "text/plain"] }),
    },
    argv: (ctx) => [ctx.path("tool.exe")],
    expected: () => ({
      code: 3, stdout: "",
      stderr: "brewpage: File type application/x-msdownload is not supported\nSupported types: image/png, application/pdf, text/plain\n",
      requests: [LIMITS_GET, filePost("/api/files", "tool.exe", "MZ")], receipt: NOTHING_SAVED,
    }),
  }),
  row("GIVEN the server answers 429 WHEN stdin is published THEN it exits 6 with Retry-After seconds and the account link", {
    stdin: () => Readable.from([Buffer.from("again\n")]),
    stub: {
      reply: failed(429, "Too Many Requests", "Too many publications; try again later.",
        { retryAfterSeconds: 120, accountUrl: "https://account.brewpage.app/" }, { "Retry-After": "120" }),
    },
    argv: () => ["-"],
    expected: () => ({
      code: 6, stdout: "",
      stderr: "brewpage: Too many publications; try again later.\nRetry after 120 seconds.\n"
        + "Higher limits with a free account: https://account.brewpage.app/\n",
      requests: [LIMITS_GET, textPost("/api/html", "text/plain", "again\n")], receipt: NOTHING_SAVED,
    }),
  }),
  row("GIVEN the API port refuses connections WHEN stdin is published THEN it exits 5", {
    stdin: () => Readable.from([Buffer.from("offline\n")]),
    setup: (ctx) => ctx.stub.close(),
    argv: () => ["-"],
    expected: (ctx) => ({
      code: 5, stdout: "", stderr: `brewpage: Could not reach ${new URL(ctx.stub.url).host} (ECONNREFUSED).\n`,
      requests: [], receipt: NOTHING_SAVED,
    }),
  }),
  row("GIVEN a receipts dir that is not writable WHEN published THEN it exits 7 with the link on stdout and PRIVATE lines on stderr", {
    files: { "page.html": "<p>Kept</p>" },
    setup: async (ctx) => {
      await mkdir(ctx.state);
      await chmod(ctx.state, 0o500);
    },
    argv: (ctx) => [ctx.path("page.html")],
    expected: (ctx) => ({
      code: 7, stdout: `${LINK}\n`,
      stderr: `${shown()}brewpage: could not save the receipt at ${ctx.receipts}: EACCES.\n${privateLines}`,
      requests: [LIMITS_GET, filePost("/api/files", "page.html", "<p>Kept</p>")],
      receipt: { dir: "500", file: "absent", lines: [] },
    }),
  }),
  row("GIVEN a symlinked receipts dir WHEN published THEN it refuses to write there and exits 7 with PRIVATE lines on stderr", {
    files: { "page.html": "<p>Linked</p>" },
    setup: async (ctx) => {
      await mkdir(ctx.path("elsewhere"), { mode: 0o700 });
      await symlink(ctx.path("elsewhere"), ctx.state);
    },
    argv: (ctx) => [ctx.path("page.html")],
    expected: (ctx) => ({
      code: 7, stdout: `${LINK}\n`,
      stderr: `${shown()}brewpage: could not save the receipt at ${ctx.receipts}: `
        + `${ctx.state} must be a real directory owned by you and writable only by you.\n${privateLines}`,
      requests: [LIMITS_GET, filePost("/api/files", "page.html", "<p>Linked</p>")],
      receipt: { dir: "700", file: "absent", lines: [] },
    }),
  }),
  row("GIVEN a terminal stdin and no argument WHEN run THEN it exits 2 without any request", {
    stdin: () => Object.assign(Readable.from([]), { isTTY: true }),
    argv: () => [],
    expected: () => ({
      code: 2, stdout: "", stderr: usage("Nothing to publish: give a file, or pipe text with `... | brewpage -`."),
      requests: [], receipt: NOTHING_SAVED,
    }),
  }),
  row("GIVEN --help WHEN run THEN stdout ends with the Help, MCP, llms.txt, Feedback and README links", {
    argv: () => ["--help"],
    pick: (observed) => ({ ...observed, stdout: observed.stdout.trimEnd().split("\n\n").at(-1).split("\n") }),
    expected: () => ({
      code: 0,
      stdout: [
        "Help: https://brewpage.app/help",
        "MCP setup and integrations: https://brewpage.app/integrations#remote-mcp",
        "Guide for LLMs: https://brewpage.app/llms.txt",
        "Feedback: info@brewpage.app",
        "README: https://github.com/kochetkov-ma/brewpage-cli#readme",
      ],
      stderr: "", requests: [], receipt: NOTHING_SAVED,
    }),
  }),
];

function collector() {
  const chunks = [];
  return { chunks, write: (chunk) => chunks.push(String(chunk)) > 0 };
}

async function mode(path) {
  return stat(path).then((info) => (info.mode & 0o777).toString(8), () => "absent");
}

async function receiptState(ctx) {
  const text = await readFile(ctx.receipts, "utf8").catch(() => "");
  return { dir: await mode(ctx.state), file: await mode(ctx.receipts), lines: text.split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}

async function prepare(spec, t) {
  const root = await mkdtemp(join(tmpdir(), "brewpage-cli-test-"));
  const stub = await startStub(spec.stub);
  t.after(() => Promise.all([stub.close(), rm(root, { recursive: true, force: true })]));
  const ctx = { root, stub, path: (name) => join(root, name), state: join(root, "state"), receipts: join(root, "state", "receipts.jsonl") };
  await Promise.all(Object.entries(spec.files).map(([name, content]) => writeFile(ctx.path(name), content)));
  await spec.setup(ctx);
  return ctx;
}

describe("brewpage CLI", { concurrency: true }, () => {
  for (const spec of ROWS) {
    it(spec.name, async (t) => {
      const ctx = await prepare(spec, t);
      const stdout = collector();
      const stderr = collector();
      const env = { BREWPAGE_URL: ctx.stub.url, BREWPAGE_STATE_DIR: ctx.state };
      const code = await main(spec.argv(ctx), { env, stdin: spec.stdin(), stdout, stderr });
      const observed = {
        code, stdout: stdout.chunks.join(""), stderr: stderr.chunks.join(""),
        requests: await Promise.all(ctx.stub.requests.map(summarize)), receipt: await receiptState(ctx),
      };
      assert.deepStrictEqual(spec.pick(observed), spec.expected(ctx), `${spec.name}: exit code, output, requests and receipt`);
      assert.deepStrictEqual(PRIVATE.filter((secret) => observed.stdout.includes(secret)), [], `${spec.name}: stdout leaks no owner token or management link`);
      assert.deepStrictEqual(
        ctx.stub.requests.map((r) => ({ ua: r.headers["user-agent"], client: r.headers["x-brewpage-client"] })),
        ctx.stub.requests.map(() => MARKERS),
        `${spec.name}: every request carries the CLI User-Agent and X-BrewPage-Client markers`,
      );
    });
  }
});
