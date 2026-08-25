import { parseArgs } from "node:util";
import { discoverAll } from "./configs.js";
import { checkCommand } from "./checks/command-resolution.js";
import { checkEnv } from "./checks/env-check.js";
import { checkHandshake } from "./checks/handshake.js";
import { checkNetwork } from "./checks/network-check.js";
import { checkDuplicates, checkPatterns } from "./checks/patterns.js";
import { renderHuman } from "./report.js";
import { applyFix, computeFix, npmGlobalRoot, REPORT_ONLY } from "./fix.js";
import type { ScanSummary, ServerResult } from "./types.js";

const HELP = `fixmcp - diagnose and fix MCP server configuration failures

Usage:
  fixmcp [options]

Options:
  --json           machine-readable output
  --fix            rewrite fragile npx-based configs (backup written first)
  --no-handshake   skip spawning servers (static checks only)
  --timeout <ms>   handshake timeout per server (default: 8000)
  -h, --help       show this help

Checks every known agent config on this machine:
  Claude Code (.claude.json) · opencode (opencode.jsonc) · Cursor (~/.cursor/mcp.json)
  VS Code (Code/User/mcp.json) · Claude Desktop · Codex CLI (~/.codex/config.toml)

Exit codes: 0 = healthy/warnings only · 1 = at least one error · 2 = internal failure`;

export async function run(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        json: { type: "boolean", default: false },
        fix: { type: "boolean", default: false },
        "no-handshake": { type: "boolean", default: false },
        timeout: { type: "string", default: "8000" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(String((err as Error).message));
    console.log(HELP);
    return 2;
  }

  if (args.values.help) {
    console.log(HELP);
    return 0;
  }
  const timeoutMs = Math.max(500, Number(args.values.timeout) || 8000);

  const { servers, configsFound } = discoverAll();
  const results: ServerResult[] = [];
  const dupFindings = checkDuplicates(servers);

  for (let i = 0; i < servers.length; i++) {
    const entry = servers[i];
    const findings = [];

    findings.push(...(await checkCommand(entry)));
    findings.push(...checkEnv(entry));
    findings.push(...checkPatterns(entry));

    const commandFatal = findings.some(
      (f) => f.check === "command-resolution" && f.severity === "error"
    );

    if (entry.enabled !== false && !commandFatal) {
      if (entry.transport === "stdio" && !args.values["no-handshake"]) {
        const hs = await checkHandshake(entry, {
          timeoutMs,
          probeTools: true,
        });
        findings.push(...hs.findings);
      } else if (entry.transport !== "stdio") {
        findings.push(...(await checkNetwork(entry)));
      }
    }

    results.push({ entry, findings });
  }

  // attach duplicate findings
  dupFindings.forEach((f, i) => results[i]?.findings.push(...f));

  // optional fixes
  if (args.values.fix) {
    const globalRoot = await npmGlobalRoot();
    if (!globalRoot) {
      console.error("fixmcp: could not determine npm global root; cannot --fix.");
    } else {
      const plans = servers
        .map((e) => computeFix(e, globalRoot))
        .filter((p): p is NonNullable<typeof p> => p !== null);
      const skippedAgents = new Set(
        servers.filter((e) => REPORT_ONLY.has(e.agent)).map((e) => e.agent)
      );
      if (plans.length > 0) {
        for (const msg of applyFix(plans)) console.log("fix :: " + msg);
      } else if (skippedAgents.size > 0) {
        console.log(
          `fix :: no auto-rewritable configs. ${[...skippedAgents].join(", ")} use JSONC/TOML - edit those manually (comments would be lost).`
        );
      } else {
        console.log("fix :: nothing to fix - all npx entries already cached/pinned or not present.");
      }
      // recompute nothing; user re-runs to verify
    }
  }

  const summary: ScanSummary = {
    results,
    configsFound,
    errors: results.reduce(
      (n, r) => n + r.findings.filter((f) => f.severity === "error").length,
      0
    ),
    warnings: results.reduce(
      (n, r) => n + r.findings.filter((f) => f.severity === "warn").length,
      0
    ),
  };

  if (args.values.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(renderHuman(summary));
  }
  return summary.errors > 0 ? 1 : 0;
}
