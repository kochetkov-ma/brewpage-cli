# brewpage

Publish a file or piped text to [BrewPage](https://brewpage.app) from the terminal and get one share link back.

Install with `brew install kochetkov-ma/brew/brewpage`. Run `brewpage <file>` or `... | brewpage -`. Share the returned link. Keep the management link private.

[Help](https://brewpage.app/help) · [MCP setup and integrations](https://brewpage.app/integrations#remote-mcp) · [Guide for LLMs](https://brewpage.app/llms.txt) · [Feedback](mailto:info@brewpage.app)

BrewPage hosts HTML, Markdown, text and files and returns an HTTPS link. No account or sign-up is needed.

## Install

Homebrew (macOS and Linux):

```bash
brew install kochetkov-ma/brew/brewpage
```

From the GitHub Release (Node.js 22 or newer):

```bash
curl -fLO https://github.com/kochetkov-ma/brewpage-cli/releases/download/v0.1.1/brewpage-0.1.1.tgz
curl -fLO https://github.com/kochetkov-ma/brewpage-cli/releases/download/v0.1.1/SHA256SUMS
shasum -a 256 -c SHA256SUMS
npm install -g ./brewpage-0.1.1.tgz
```

npm: coming soon.

## Usage

```bash
brewpage report.html                        # publish a file, print its link
cat notes.md | brewpage - --format markdown # publish piped text as a Markdown page
git log --oneline -20 | brewpage -          # piped text; the server picks the format
brewpage photo.png --public                 # list it publicly
brewpage page.html --ttl 7                  # keep it 7 days
link=$(brewpage page.html)                  # stdout holds only the link
```

`brewpage publish <file|->` does the same as `brewpage <file|->`. With no argument and piped input, it reads stdin.

| Option | Meaning |
|---|---|
| `--public` | List it publicly (gallery, sitemap, search). Default: unlisted, only people with the link can open it. |
| `--ttl N` | Keep it N days, up to the maximum the server allows. Default: the server's. |
| `--format F` | Page format for stdin or a file: `html`, `markdown` or `text`. Default: the server picks. |
| `--receipts <abs>` | Absolute path of the receipts file. |
| `--no-save` | Keep no receipt: you cannot edit or delete the publication later. |
| `-q`, `--quiet` | Print only the link, notices and errors. |
| `-h`, `--help` | Show help. |
| `-v`, `--version` | Show the version. |

HTML and Markdown files become pages; other files are shared as files. Before uploading, the CLI reads the current limits from the server and stops early when a file or `--ttl` is over them.

## Output

- stdout: the link only, so scripts can capture it.
- stderr: expiry, access, the receipt path, notices and errors. When the server issues a new owner token, the CLI saves it and says so in one line naming the receipts file.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Published |
| 1 | Unexpected error |
| 2 | Usage or input error (bad option, missing or empty input, `--ttl` over the maximum) |
| 3 | Refused by the server; an unsupported type lists the accepted types |
| 4 | Too large (checked before upload, or refused by the server) |
| 5 | Network failure, timeout, server error, or limits unavailable |
| 6 | Rate limited; prints how many seconds to wait and where to get higher limits with a free account |
| 7 | Published, but the receipt was not saved |

## Receipts and privacy

Each publication adds one JSON line to:

```
${BREWPAGE_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/brewpage}/receipts.jsonl
```

A line holds `link`, the management link (`manageUrl`, or `managementLink` when the server issued no new key), `ownerToken`, `expiresAt`, `namespace`, `id` and `access`. The folder is created with mode 0700 and the file with 0600; the CLI refuses a symlinked folder or file, either one owned by someone else, a folder others can write, or a file whose mode is not 0600.

Keep the management link and the owner token private: anyone who has them can edit or delete the publication. They never go to stdout. If the receipt cannot be saved, the link still goes to stdout, the management link and owner token go to stderr marked PRIVATE, and the CLI exits with 7: copy them somewhere safe.

The CLI sends BrewPage only your content, its file name and your options. Every request carries `User-Agent: brewpage-cli/<version>` and `X-BrewPage-Client: cli/<version>`, so BrewPage can count publishes made with the CLI.

## Environment

| Variable | Meaning |
|---|---|
| `BREWPAGE_URL` | Server address. Default `https://brewpage.app`; https only (http only for localhost). |
| `BREWPAGE_STATE_DIR` | Absolute folder for `receipts.jsonl`. |
| `XDG_STATE_HOME` | Used when `BREWPAGE_STATE_DIR` is not set; default `~/.local/state`. |

## Links

- [Help](https://brewpage.app/help)
- [MCP setup and integrations](https://brewpage.app/integrations#remote-mcp): publish from Claude, ChatGPT and other AI clients
- [Guide for LLMs](https://brewpage.app/llms.txt)
- Feedback: [info@brewpage.app](mailto:info@brewpage.app) or [GitHub issues](https://github.com/kochetkov-ma/brewpage-cli/issues)

## Development

```bash
npm test
```

No dependencies. The tests run the CLI against a local stub server.

## License

[Apache-2.0](LICENSE)
