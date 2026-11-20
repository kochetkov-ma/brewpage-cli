#!/usr/bin/env node
import { main } from "../src/cli.js";

// A closed stdout pipe (EPIPE) must not crash the run before the receipt is saved.
process.stdout.on("error", () => undefined);
process.exitCode = await main(process.argv.slice(2));
