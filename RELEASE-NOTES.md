# Release Notes

## 0.1.0

First release: publish from the terminal to [BrewPage](https://brewpage.app) and get one share link.

- `brewpage <file>` publishes a file; HTML and Markdown files become pages. `... | brewpage -` publishes piped text, and `--format html|markdown|text` picks the page format.
- Publications are unlisted by default: only people with the link can open them. `--public` lists one publicly; `--ttl N` sets how many days it stays.
- stdout holds only the link, so scripts can capture it. Expiry, access and notices go to stderr.
- The management link and owner token are saved privately, by default in `~/.local/state/brewpage/receipts.jsonl` (owner-only folder and file), and never printed to stdout. Keep them private: they can edit or delete the publication.
- Oversize files and a `--ttl` over the maximum stop before anything is uploaded. Clear exit codes tell scripts what happened, including rate limits with the wait time.
- Install with `brew install kochetkov-ma/brew/brewpage` or from the release tarball. npm is coming soon.
