import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  parse as parseJsonc,
  type ParseError,
} from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import type { ServerEntry, Transport } from "./types.js";

export const AGENTS = [
  "claude-code",
  "claude-desktop",
  "opencode",
  "cursor",
  "vscode",
  "codex",
] as const;
export type AgentId = (typeof AGENTS)[number];

export interface DiscoverOptions {
  homeDir?: string;
  appData?: string;
}

function platformDirs(opts?: DiscoverOptions) {
  const home = opts?.homeDir ?? homedir();
  const appData =
    opts?.appData ??
    process.env.APPDATA ?? // win32
    (process.platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : path.join(home, ".config"));
  return { home, appData };
}

/** Every known config location per agent, for the current platform. */
export function configTargets(opts?: DiscoverOptions) {
  const { home, appData } = platformDirs(opts);
  return [
    {
      agent: "claude-code" as AgentId,
      paths: [path.join(home, ".claude.json")],
      format: "json" as const,
      label: "Claude Code",
    },
    {
      agent: "claude-desktop" as AgentId,
      paths: [
        path.join(appData, "Claude", "claude_desktop_config.json"),
        path.join(home, ".config", "Claude", "claude_desktop_config.json"),
      ],
      format: "json" as const,
      label: "Claude Desktop",
    },
    {
      agent: "opencode" as AgentId,
      paths: [
        path.join(home, ".config", "opencode", "opencode.jsonc"),
        path.join(home, ".config", "opencode", "opencode.json"),
      ],
      format: "jsonc" as const,
      label: "opencode",
    },
    {
      agent: "cursor" as AgentId,
      paths: [path.join(home, ".cursor", "mcp.json")],
      format: "json" as const,
      label: "Cursor",
    },
    {
      agent: "vscode" as AgentId,
      paths: [path.join(appData, "Code", "User", "mcp.json")],
      format: "json" as const,
      label: "VS Code",
    },
    {
      agent: "codex" as AgentId,
      paths: [path.join(home, ".codex", "config.toml")],
      format: "toml" as const,
      label: "Codex CLI",
    },
  ];
}

function readFileSafe(p: string): string | null {
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}

function parseJsonOrJsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors);
  if (errors.length > 0 && value === undefined) {
    throw new Error("invalid JSON/JSONC");
  }
  return value;
}

function inferTransport(entry: Record<string, unknown>): Transport {
  if (typeof entry.url === "string" && entry.url) {
    return entry.type === "sse" ? "sse" : "http";
  }
  return "stdio";
}

/** Parse the `mcpServers`-style maps used by Claude/Cursor/VS Code. */
function parseMcpServersMap(
  agent: AgentId,
  configFile: string,
  raw: unknown,
  key: string
): ServerEntry[] {
  const out: ServerEntry[] = [];
  if (!raw || typeof raw !== "object") return out;
  const root = raw as Record<string, unknown>;
  const map = root[key];
  if (!map || typeof map !== "object") return out;
  for (const [name, value] of Object.entries(map as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const e = value as Record<string, unknown>;
    out.push({
      agent,
      configFile,
      name,
      transport: inferTransport(e),
      command: typeof e.command === "string" ? e.command : undefined,
      args: Array.isArray(e.args) ? e.args.map(String) : undefined,
      url: typeof e.url === "string" ? e.url : undefined,
      env:
        e.env && typeof e.env === "object"
          ? Object.fromEntries(
              Object.entries(e.env as Record<string, unknown>).map(([k, v]) => [
                k,
                String(v),
              ])
            )
          : undefined,
      enabled: true,
    });
  }
  return out;
}

function parseOpencode(configFile: string, text: string): ServerEntry[] {
  const out: ServerEntry[] = [];
  const root = parseJsonOrJsonc(text) as Record<string, unknown> | undefined;
  const map = root?.mcp;
  if (!map || typeof map !== "object") return out;
  for (const [name, value] of Object.entries(map as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const e = value as Record<string, unknown>;
    const enabled = e.enabled !== false;
    if (e.type === "remote" && typeof e.url === "string") {
      out.push({
        agent: "opencode",
        configFile,
        name,
        transport: "http",
        url: e.url,
        enabled,
      });
    } else {
      out.push({
        agent: "opencode",
        configFile,
        name,
        transport: "stdio",
        command: Array.isArray(e.command) ? String(e.command[0]) : undefined,
        args: Array.isArray(e.command)
          ? e.command.slice(1).map(String)
          : undefined,
        env:
          e.environment && typeof e.environment === "object"
            ? Object.fromEntries(
                Object.entries(e.environment as Record<string, unknown>).map(
                  ([k, v]) => [k, String(v)]
                )
              )
            : undefined,
        enabled,
      });
    }
  }
  return out;
}

function parseCodex(configFile: string, text: string): ServerEntry[] {
  const out: ServerEntry[] = [];
  let root: unknown;
  try {
    root = parseToml(text);
  } catch {
    return out;
  }
  const map = (root as Record<string, unknown>)?.mcp_servers;
  if (!map || typeof map !== "object") return out;
  for (const [name, value] of Object.entries(map as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const e = value as Record<string, unknown>;
    out.push({
      agent: "codex",
      configFile,
      name,
      transport: typeof e.url === "string" ? "http" : "stdio",
      command: typeof e.command === "string" ? e.command : undefined,
      args: Array.isArray(e.args) ? e.args.map(String) : undefined,
      url: typeof e.url === "string" ? e.url : undefined,
      env:
        e.env && typeof e.env === "object"
          ? Object.fromEntries(
              Object.entries(e.env as Record<string, unknown>).map(([k, v]) => [
                k,
                String(v),
              ])
            )
          : undefined,
      enabled: true,
    });
  }
  return out;
}

/** Parse one agent config file into normalized server entries. */
export function parseConfigFile(
  agent: AgentId,
  filePath: string
): ServerEntry[] {
  const text = readFileSafe(filePath);
  if (text === null) return [];
  try {
    switch (agent) {
      case "claude-code":
        return parseMcpServersMap(
          agent,
          filePath,
          parseJsonOrJsonc(text),
          "mcpServers"
        );
      case "claude-desktop":
        return parseMcpServersMap(
          agent,
          filePath,
          parseJsonOrJsonc(text),
          "mcpServers"
        );
      case "cursor":
        return parseMcpServersMap(agent, filePath, JSON.parse(text), "mcpServers");
      case "vscode": {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const key = parsed.servers ? "servers" : "mcpServers";
        return parseMcpServersMap(agent, filePath, parsed, key);
      }
      case "opencode":
        return parseOpencode(filePath, text);
      case "codex":
        return parseCodex(filePath, text);
    }
  } catch {
    return [];
  }
}

export interface DiscoveryResult {
  servers: ServerEntry[];
  configsFound: { agent: string; path: string }[];
}

/** Scan every known agent config location on this machine. */
export function discoverAll(opts?: DiscoverOptions): DiscoveryResult {
  const servers: ServerEntry[] = [];
  const configsFound: { agent: string; path: string }[] = [];
  for (const target of configTargets(opts)) {
    for (const p of target.paths) {
      if (!existsSync(p)) continue;
      configsFound.push({ agent: target.agent, path: p });
      servers.push(...parseConfigFile(target.agent, p));
      break; // first existing variant wins per agent
    }
  }
  return { servers, configsFound };
}
