import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { CliError, EXIT } from "./api.js";

const FILE = "receipts.jsonl";

/** `--receipts`, else ${BREWPAGE_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/brewpage}/receipts.jsonl. */
export function receiptsPath(env, override) {
  if (override !== undefined) {
    if (!isAbsolute(override)) throw new CliError(EXIT.USAGE, "--receipts needs an absolute path.");
    return override;
  }
  if (env.BREWPAGE_STATE_DIR) {
    if (!isAbsolute(env.BREWPAGE_STATE_DIR)) throw new CliError(EXIT.USAGE, "BREWPAGE_STATE_DIR must be an absolute path.");
    return join(env.BREWPAGE_STATE_DIR, FILE);
  }
  // XDG: a relative XDG_STATE_HOME is invalid and ignored.
  const state = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(env.HOME || homedir(), ".local", "state");
  return join(state, "brewpage", FILE);
}

/** One receipt line: manageUrl when minted, else the key-less managementLink. */
export function receiptRecord(answer) {
  return {
    link: answer.link,
    ...(answer.manageUrl ? { manageUrl: answer.manageUrl } : answer.managementLink ? { managementLink: answer.managementLink } : {}),
    ownerToken: answer.ownerToken || undefined,
    expiresAt: answer.expiresAt,
    namespace: answer.namespace,
    id: answer.id,
    access: answer.access,
  };
}

function localUser() {
  if (process.getuid === undefined) throw new Error("receipts need a POSIX owner check");
  return process.getuid();
}

/** Appends one JSON line: owner-only 0700-created dir, no symlinks, regular 0600 file owned by this user. */
export async function saveReceipt(path, record) {
  const uid = localUser();
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0) {
    throw new Error(`${dir} must be a real directory owned by you and writable only by you`);
  }
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const file = await open(path, flags, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600) {
      throw new Error(`${path} must be a regular 0600 file owned by you`);
    }
    await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}
