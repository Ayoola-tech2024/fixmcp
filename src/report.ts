import type { ScanSummary, ServerResult, Severity } from "./types.js";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

const ICONS: Record<Severity, string> = {
  error: "✗",
  warn: "⚠",
  info: "·",
  ok: "✓",
};
const COLORS: Record<Severity, string> = {
  error: C.red,
  warn: C.yellow,
  info: C.cyan,
  ok: C.green,
};

export function renderHuman(summary: ScanSummary): string {
  const lines: string[] = [];
  const byAgent = new Map<string, ServerResult[]>();
  for (const r of summary.results) {
    byAgent.set(r.entry.agent, [...(byAgent.get(r.entry.agent) ?? []), r]);
  }

  lines.push(`${C.bold}fixmcp${C.reset} - MCP configuration doctor`);
  if (summary.configsFound.length > 0) {
    lines.push(
      `${C.dim}configs:${C.reset} ${summary.configsFound.map((c) => `${c.agent} (${c.path})`).join(", ")}`
    );
  } else {
    lines.push("no MCP configs found on this machine.");
  }
  lines.push("");

  for (const [agent, results] of byAgent) {
    lines.push(`${C.bold}${agent}${C.reset}`);
    for (const r of results) {
      const sev = pickWorst(r);
      const icon = ICONS[sev];
      const color = COLORS[sev];
      const meta = [
        r.entry.enabled === false ? "disabled" : null,
        r.handshakeMs !== undefined ? `${r.handshakeMs}ms` : null,
        r.toolCount !== undefined ? `${r.toolCount} tools` : null,
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(
        `  ${color}${icon}${C.reset} ${C.bold}${r.entry.name}${C.reset} ${C.dim}(${r.entry.transport}${meta ? ` · ${meta}` : ""})${C.reset}`
      );
      for (const f of r.findings) {
        if (f.severity === "ok" && sev !== "ok") continue; // don't spam OKs under a failing server
        lines.push(`      ${COLORS[f.severity]}${ICONS[f.severity]}${C.reset} [${f.check}] ${f.message}`);
        if (f.detail) lines.push(`        ${C.dim}${f.detail}${C.reset}`);
      }
    }
    lines.push("");
  }

  const { errors, warnings } = summary;
  const verdict =
    errors > 0
      ? `${C.red}${errors} error(s), ${warnings} warning(s)${C.reset}`
      : warnings > 0
        ? `${C.yellow}${warnings} warning(s), no errors${C.reset}`
        : `${C.green}all servers healthy${C.reset}`;
  lines.push(verdict);
  return lines.join("\n");
}

function pickWorst(r: ServerResult): Severity {
  if (r.findings.some((f) => f.severity === "error")) return "error";
  if (r.findings.some((f) => f.severity === "warn")) return "warn";
  if (r.findings.some((f) => f.severity === "info")) return "info";
  return "ok";
}
