export type Transport = "stdio" | "http" | "sse";

/** A normalized MCP server entry extracted from an agent's config file. */
export interface ServerEntry {
  /** Agent id: claude-code | claude-desktop | opencode | cursor | vscode | codex */
  agent: string;
  /** Absolute path of the config file this entry came from */
  configFile: string;
  /** Server name as keyed in the config */
  name: string;
  transport: Transport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** false when the entry is explicitly disabled (e.g. opencode `enabled:false`) */
  enabled?: boolean;
}

export type Severity = "error" | "warn" | "info" | "ok";

export interface Finding {
  check: string;
  severity: Severity;
  message: string;
  /** extra technical detail (stderr tails, elapsed ms, resolved paths) */
  detail?: string;
}

export interface ServerResult {
  entry: ServerEntry;
  findings: Finding[];
  handshakeMs?: number;
  toolCount?: number;
}

export interface ScanSummary {
  results: ServerResult[];
  configsFound: { agent: string; path: string }[];
  errors: number;
  warnings: number;
}
