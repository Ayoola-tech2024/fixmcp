#!/usr/bin/env node
import { run } from "../dist/cli.js";

run(process.argv.slice(2)).catch((err) => {
  console.error("fixmcp: internal error:", err?.message ?? err);
  process.exit(2);
});
