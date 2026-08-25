import type { Finding, ServerEntry } from "../types.js";

/** Finds ${VAR} references (in env values or args) that are unset on this machine. */
export function checkEnv(entry: ServerEntry): Finding[] {
  const findings: Finding[] = [];
  const referenced = new Set<string>();

  const scanString = (s: string) => {
    for (const m of s.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      referenced.add(m[1]);
    }
  };

  for (const v of Object.values(entry.env ?? {})) scanString(v);
  for (const a of entry.args ?? []) scanString(a);
  if (entry.url) scanString(entry.url);

  for (const name of referenced) {
    if (process.env[name] === undefined) {
      findings.push({
        check: "env",
        severity: "error",
        message: `environment variable \${${name}} is referenced but not set - server will start without its credential/config.`,
        detail: `Set it in your shell profile or the server's env block in ${entry.configFile}.`,
      });
    }
  }
  return findings;
}
