import type { Finding, ServerEntry } from "../types.js";

/**
 * Known-issue pattern rules - things that are syntactically valid configs
 * but break in practice. Each rule encodes a real-world failure mode.
 */
export function checkPatterns(entry: ServerEntry): Finding[] {
  const findings: Finding[] = [];

  if (
    entry.transport === "stdio" &&
    /^(npx|bunx)$/i.test(entry.command ?? "") &&
    entry.args !== undefined
  ) {
    const hasYes = entry.args.some((a) => /^(-y|--yes)$/.test(a));
    if (!hasYes) {
      findings.push({
        check: "patterns",
        severity: "warn",
        message:
          'npx without "-y" can prompt interactively to install the package - agents run non-interactive and hang forever.',
        detail: 'Add "-y" as the first npx argument.',
      });
    }
  }

  if (entry.agent === "claude-desktop") {
    const raw = entry as ServerEntry & { timeout?: unknown };
    if ("timeout" in raw && raw.timeout !== undefined) {
      findings.push({
        check: "patterns",
        severity: "info",
        message:
          '"timeout" field present but Claude Desktop silently ignores it (anthropics/claude-code#43791).',
        detail: "Use environment variables or server-side progress notifications instead.",
      });
    }
  }

  return findings;
}

/** Duplicate server names across different agents cause silent override confusion. */
export function checkDuplicates(all: ServerEntry[]): Finding[][] {
  const byName = new Map<string, ServerEntry[]>();
  for (const e of all) {
    byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
  }
  const out: Finding[][] = all.map(() => []);
  all.forEach((entry, i) => {
    const twins = (byName.get(entry.name) ?? []).filter(
      (t) => t.configFile !== entry.configFile
    );
    if (twins.length > 0) {
      out[i].push({
        check: "duplicates",
        severity: "info",
        message: `"${entry.name}" is also defined in ${twins.map((t) => `${t.agent} (${t.configFile})`).join(", ")} - different agents may silently run different implementations of the same name.`,
      });
    }
  });
  return out;
}
