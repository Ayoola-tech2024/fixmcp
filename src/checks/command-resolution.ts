import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Finding, ServerEntry, Severity } from "../types.js";

const execFileP = promisify(execFile);

const WIN_EXTS = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");

async function which(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      process.platform === "win32" ? "where.exe" : "which",
      [command],
      { timeout: 5000 }
    );
    const first = stdout.split(/\r?\n/).find((l) => l.trim());
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

export interface CommandCheckOptions {
  /** skip PATH lookup for tests */
  whichFn?: (cmd: string) => Promise<string | null>;
}

/**
 * Verifies a stdio server's command actually resolves on this machine,
 * and flags npx-style commands whose package resolution happens at startup.
 */
export async function checkCommand(
  entry: ServerEntry,
  opts?: CommandCheckOptions
): Promise<Finding[]> {
  if (entry.transport !== "stdio" || !entry.command) {
    return [];
  }
  const findings: Finding[] = [];
  const whichFn = opts?.whichFn ?? which;
  const cmd = entry.command;
  const isNpx = /^(npx|bunx|pnpm\s+dlx)$/i.test(path.basename(cmd)) || /^(npx|bunx)$/i.test(cmd);

  if (isNpx) {
    // npx always resolves; what matters is what it has to download
    const pkgArg = entry.args?.find(
      (a) => !a.startsWith("-") && (a.includes("@") || /^[a-z@]/i.test(a))
    );
    const unpinned =
      pkgArg !== undefined &&
      (pkgArg.endsWith("@latest") || !pkgArg.includes("@", 1));
    if (unpinned) {
      findings.push({
        check: "command-resolution",
        severity: "warn",
        message: `npx resolves "${pkgArg}" from the registry at EVERY agent startup - on slow/offline boots this is the classic cause of "MCP error -32001 Request timed out".`,
        detail:
          "Fix: install globally (npm i -g) and point the config at the installed script, or pin an exact version.",
      });
    } else {
      findings.push({
        check: "command-resolution",
        severity: "ok",
        message: `npx with pinned package "${pkgArg ?? "?"}".`,
      });
    }
    return findings;
  }

  const direct =
    path.isAbsolute(cmd) && existsSync(cmd)
      ? cmd
      : existsSync(cmd)
        ? path.resolve(cmd)
        : null;

  if (direct) {
    findings.push({
      check: "command-resolution",
      severity: "ok",
      message: `command found: ${direct}`,
    });
    return findings;
  }

  const resolved = await whichFn(cmd);
  if (!resolved) {
    findings.push({
      check: "command-resolution",
      severity: "error",
      message: `command "${cmd}" not found on PATH - the server can never start.`,
      detail: `Searched PATH${process.platform === "win32" ? ` + PATHEXT (${WIN_EXTS.join(", ")})` : ""}.`,
    });
    return findings;
  }

  findings.push({
    check: "command-resolution",
    severity: "ok",
    message: `command resolved: ${resolved}`,
  });

  // node script targets: verify the script file exists
  const firstArg = entry.args?.[0];
  if (
    path.basename(resolved).match(/^node(\.exe)?$/i) &&
    firstArg &&
    !firstArg.startsWith("-")
  ) {
    const script = path.isAbsolute(firstArg)
      ? firstArg
      : path.resolve(firstArg);
    if (!existsSync(script)) {
      findings.push({
        check: "command-resolution",
        severity: "error",
        message: `script not found: ${script}`,
      });
    }
  }

  return findings;
}

export function worstSeverity(findings: Finding[]): Severity | null {
  if (findings.some((f) => f.severity === "error")) return "error";
  if (findings.some((f) => f.severity === "warn")) return "warn";
  if (findings.some((f) => f.severity === "info")) return "info";
  if (findings.some((f) => f.severity === "ok")) return "ok";
  return null;
}
