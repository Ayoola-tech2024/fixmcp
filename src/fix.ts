import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServerEntry } from "./types.js";

const execFileP = promisify(execFile);

/** Agents whose config is plain JSON - safe to rewrite programmatically. */
export const REWRITABLE = new Set(["claude-code", "claude-desktop", "cursor", "vscode"]);
/** JSONC/TOML configs would lose comments/formatting - report-only. */
export const REPORT_ONLY = new Set(["opencode", "codex"]);

export interface FixPlan {
  entry: ServerEntry;
  /** new command to use */
  command: string;
  /** new args */
  args: string[];
  scriptPath: string;
  explanation: string;
}

function parseNpxTarget(args: string[] | undefined): { pkg: string; rest: string[] } | null {
  if (!args) return null;
  const filtered = args.filter((a) => /^(-y|--yes|--no-install)$/.test(a) ? false : true);
  const idx = filtered.findIndex((a) => !a.startsWith("-"));
  if (idx === -1) return null;
  const raw = filtered[idx];
  const at = raw.lastIndexOf("@");
  const pkg = at > 0 ? raw.slice(0, at) : raw;
  return { pkg, rest: [...filtered.slice(idx + 1)] };
}

/**
 * Compute the rewrite plan for an `npx -y <pkg>` style entry whose package
 * is already installed under globalRoot. Returns null when no safe rewrite
 * is possible.
 */
export function computeFix(entry: ServerEntry, globalRoot: string): FixPlan | null {
  if (entry.transport !== "stdio") return null;
  if (!/^(npx)$/i.test(path.basename(entry.command ?? ""))) return null;
  if (!REWRITABLE.has(entry.agent)) return null;
  const target = parseNpxTarget(entry.args);
  if (!target) return null;

  const pkgDir = path.join(globalRoot, ...target.pkg.split("/"));
  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return null;

  let scriptRel: string | undefined;
  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
      main?: string;
    };
    if (typeof pkgJson.bin === "string") scriptRel = pkgJson.bin;
    else if (pkgJson.bin && typeof pkgJson.bin === "object") {
      scriptRel = pkgJson.bin[target.pkg.split("/").pop()!] ?? Object.values(pkgJson.bin)[0];
    } else if (pkgJson.main) scriptRel = pkgJson.main;
  } catch {
    return null;
  }
  if (!scriptRel) return null;

  const scriptPath = path.join(pkgDir, scriptRel);
  if (!existsSync(scriptPath)) return null;

  return {
    entry,
    command: process.execPath,
    args: [scriptPath, ...target.rest],
    scriptPath,
    explanation: `"npx ${entry.args!.join(" ")}" → node ${scriptPath}${target.rest.length ? " " + target.rest.join(" ") : ""} (no registry round-trip at startup)`,
  };
}

export async function npmGlobalRoot(): Promise<string | null> {
  try {
    const { stdout } = await execFileP(process.platform === "win32" ? "npm.cmd" : "npm", [
      "root",
      "-g",
    ], { timeout: 15000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Apply all computable fixes for one config file atomically-ish:
 * writes a .fixmcp.bak backup next to the original first.
 * Returns human-readable list of applied fixes.
 */
export function applyFix(plans: FixPlan[]): string[] {
  const applied: string[] = [];
  const byFile = new Map<string, FixPlan[]>();
  for (const p of plans) {
    byFile.set(p.entry.configFile, [...(byFile.get(p.entry.configFile) ?? []), p]);
  }
  for (const [file, plansForFile] of byFile) {
    try {
      copyFileSync(file, file + ".fixmcp.bak");
      const text = readFileSync(file, "utf8");
      let updated = text;
      for (const plan of plansForFile) {
        const oldJson = JSON.stringify({
          command: plan.entry.command,
          ...(plan.entry.args ? { args: plan.entry.args } : {}),
        });
        const newJson = JSON.stringify({ command: plan.command, args: plan.args });
        if (updated.includes(oldJson)) {
          updated = updated.replace(oldJson, newJson);
          applied.push(`${path.basename(file)} :: ${plan.entry.name}: ${plan.explanation}`);
        } else {
          applied.push(
            `${path.basename(file)} :: ${plan.entry.name}: SKIPPED (config formatting not literal-matched; edit manually → ${plan.explanation})`
          );
        }
      }
      writeFileSync(file, updated);
    } catch (err) {
      applied.push(`${file}: FAILED to write (${(err as Error).message}); backup kept.`);
    }
  }
  return applied;
}
