import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { CliError, EXIT, VERSION, baseUrl, clean, fileLimit, getLimits, mb, overText, publishFile, publishText, textLimit } from "./api.js";
import { receiptRecord, receiptsPath, saveReceipt } from "./receipts.js";

const FORMATS = ["html", "markdown", "text"];
// Server notice addressed to API agents about a new owner token; the CLI keeps it and says so in its own line.
const TOKEN_NOTICE = "owner-token-new";
const OPTIONS = {
  public: { type: "boolean" },
  ttl: { type: "string" },
  format: { type: "string" },
  receipts: { type: "string" },
  "no-save": { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
};

export const HELP = [
  `brewpage ${VERSION}: publish a file or stdin to brewpage.app and print the link.`,
  "",
  "Install with `brew install kochetkov-ma/brew/brewpage`. Run `brewpage <file>` or `... | brewpage -`.",
  "Share the returned link. Keep the management link private: it can edit or delete the publication.",
  "",
  "Usage:",
  "  brewpage [publish] <file|-> [--public] [--ttl N] [--format html|markdown|text] [--receipts <abs> | --no-save] [--quiet]",
  "",
  "Options:",
  "  --public            List it publicly (gallery, sitemap, search). Default: unlisted, only people with the link.",
  "  --ttl N             Keep it N days, up to the maximum the server allows. Default: the server's.",
  "  --format F          Page format for stdin or a file: html, markdown or text. Default: the server picks.",
  "  --receipts <abs>    Absolute path of the receipts file.",
  "  --no-save           Keep no receipt: edit and delete are lost.",
  "  -q, --quiet         Print only the link, notices and errors.",
  "  -h, --help          Show this help.",
  "  -v, --version       Show the version.",
  "",
  "Output: stdout = the link only; expiry, access, receipt path and notices go to stderr.",
  "Receipts (private: management link, owner token): ${BREWPAGE_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/brewpage}/receipts.jsonl",
  "Exit codes: 0 published, 1 unexpected, 2 usage, 3 refused, 4 too large, 5 network or server, 6 rate limited,",
  "  7 published but the receipt was not saved.",
  "",
  "Help: https://brewpage.app/help",
  "MCP setup and integrations: https://brewpage.app/integrations#remote-mcp",
  "Guide for LLMs: https://brewpage.app/llms.txt",
  "Feedback: info@brewpage.app",
  "README: https://github.com/kochetkov-ma/brewpage-cli#readme",
  "",
].join("\n");

function usage(message) {
  return new CliError(EXIT.USAGE, message, ["Run `brewpage --help` for usage."]);
}

function parse(argv) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw usage(error.message);
  }
}

function target(positionals, stdin) {
  const rest = positionals[0] === "publish" ? positionals.slice(1) : positionals;
  if (rest.length > 1) throw usage("Give one file, or - for stdin.");
  if (rest.length === 1) return rest[0];
  if (stdin.isTTY) throw usage("Nothing to publish: give a file, or pipe text with `... | brewpage -`.");
  return "-";
}

function days(text) {
  if (!/^[1-9]\d{0,3}$/.test(text)) throw usage("--ttl must be a whole number of days, 1 or more.");
  return Number(text);
}

async function regularFile(path) {
  let info;
  try {
    info = await stat(path);
    await access(path, constants.R_OK);
  } catch (error) {
    throw usage(error.code === "ENOENT" ? `No such file: ${path}` : `Cannot read ${path} (${error.code ?? error.message}).`);
  }
  if (!info.isFile()) throw usage(`Not a regular file: ${path}. Pipe other input with \`... | brewpage -\`.`);
  if (info.size === 0) throw usage(`Nothing to publish: ${path} is empty.`);
  return info;
}

/** Reads stdin up to `max` bytes; null once it is larger. */
async function readCapped(stream, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += bytes.length;
    if (size > max) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function publish(input, options, base, say) {
  const limits = await getLimits(base);
  const cap = input.file ? limits.files.maxTtlDays : limits.html.maxTtlDays;
  if (options.ttl !== undefined && options.ttl > cap) throw usage(`--ttl may be at most ${cap} days.`);
  const request = { ns: options.public ? "public" : undefined, ttl: options.ttl, format: options.format };
  if (input.file) {
    const limit = fileLimit(limits, input.path);
    if (input.file.size > limit.maxBytes) {
      throw new CliError(EXIT.TOO_LARGE, `${basename(input.path)} is ${overText(input.file.size, limit.maxBytes, limit.kind)}.`);
    }
    return publishFile(base, { ...request, path: input.path });
  }
  const limit = textLimit(limits);
  if (input.stdin.isTTY && !options.quiet) say("Reading from the terminal; finish with Ctrl-D.");
  const body = await readCapped(input.stdin, limit.maxBytes);
  if (body === null) throw new CliError(EXIT.TOO_LARGE, `stdin is larger than ${mb(limit.maxBytes)}, the most a page may hold.`);
  if (body.length === 0) throw usage("Nothing to publish: stdin is empty.");
  return publishText(base, { ...request, body });
}

async function keep(answer, path, say) {
  if (path === undefined) {
    say("Not saved (--no-save): you cannot edit or delete this publication later.");
    return EXIT.OK;
  }
  const record = receiptRecord(answer);
  try {
    await saveReceipt(path, record);
  } catch (error) {
    say(`brewpage: could not save the receipt at ${path}: ${error.code ?? error.message}.`);
    if (record.manageUrl) say(`PRIVATE management link (edit or delete; keep it secret): ${clean(record.manageUrl)}`);
    if (record.managementLink) say(`PRIVATE management page: ${clean(record.managementLink)}`);
    if (record.ownerToken) say(`PRIVATE owner token (keep it secret): ${clean(record.ownerToken)}`);
    return EXIT.NOT_SAVED;
  }
  return EXIT.OK;
}

async function run(argv, env, stdin, stdout, say) {
  const { values, positionals } = parse(argv);
  if (values.help) {
    stdout.write(HELP);
    return EXIT.OK;
  }
  if (values.version) {
    stdout.write(`brewpage ${VERSION}\n`);
    return EXIT.OK;
  }
  const path = target(positionals, stdin);
  if (values.format !== undefined && !FORMATS.includes(values.format)) throw usage(`--format must be one of: ${FORMATS.join(", ")}.`);
  if (values["no-save"] && values.receipts !== undefined) throw usage("--receipts and --no-save cannot be used together.");
  const options = { public: values.public, ttl: values.ttl === undefined ? undefined : days(values.ttl), format: values.format, quiet: values.quiet };
  const receipts = values["no-save"] ? undefined : receiptsPath(env, values.receipts);
  const input = path === "-" ? { stdin } : { path, file: await regularFile(path) };
  const base = baseUrl(env.BREWPAGE_URL);
  const answer = await publish(input, options, base, say);
  stdout.write(`${answer.link}\n`);
  if (!options.quiet) {
    if (answer.expiresAt) say(`Expires: ${clean(answer.expiresAt)}`);
    if (answer.access) say(`Access: ${clean(answer.access)}`);
  }
  const notices = Array.isArray(answer.notices) ? answer.notices : [];
  for (const notice of notices) {
    if (notice?.message && notice.code !== TOKEN_NOTICE) say(`Notice: ${clean(notice.message)}`);
  }
  const code = await keep(answer, receipts, say);
  if (code !== EXIT.OK || receipts === undefined) return code;
  if (notices.some((notice) => notice?.code === TOKEN_NOTICE)) {
    say(`Saved your owner token and management link to ${receipts}; keep that file private.`);
  } else if (!options.quiet) {
    say(`Receipt: ${receipts} (private: management link and owner token)`);
  }
  return code;
}

/** Runs the CLI and returns its exit code; streams and env are injectable for tests. */
export async function main(argv, { env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  const say = (line) => stderr.write(`${line}\n`);
  try {
    return await run(argv, env, stdin, stdout, say);
  } catch (error) {
    if (!(error instanceof CliError)) {
      say(`brewpage: unexpected error: ${error?.message ?? error}`);
      return EXIT.UNEXPECTED;
    }
    say(`brewpage: ${error.message}`);
    for (const line of error.details) say(line);
    return error.exitCode;
  }
}
