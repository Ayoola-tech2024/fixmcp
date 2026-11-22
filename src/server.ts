import * as readline from "node:readline";
import { discoverAll, configTargets } from "./configs.js";
import { checkCommand } from "./checks/command-resolution.js";
import { checkEnv } from "./checks/env-check.js";
import { checkHandshake } from "./checks/handshake.js";
import { checkNetwork } from "./checks/network-check.js";
import { checkDuplicates, checkPatterns } from "./checks/patterns.js";
import { applyFix, computeFix, npmGlobalRoot, REPORT_ONLY } from "./fix.js";
import type { ScanSummary, ServerEntry, ServerResult } from "./types.js";

export const MCP_TOOLS = [
  {
    name: "diagnose_mcp_configs",
    description:
      "Discover and diagnose MCP server configurations across Claude Code, Claude Desktop, Cursor, VS Code, opencode, and Codex CLI. Performs static checks (command resolution, env vars, footgun patterns, duplicates) and optional live JSON-RPC stdio handshakes.",
    inputSchema: {
      type: "object",
      properties: {
        skipHandshake: {
          type: "boolean",
          description:
            "If true, perform static config checks only without spawning stdio servers (default: false).",
        },
        timeoutMs: {
          type: "number",
          description:
            "Handshake timeout per stdio server in milliseconds (default: 8000).",
        },
        homeDir: {
          type: "string",
          description:
            "Optional custom home directory path to scan instead of the current OS user home.",
        },
      },
      required: [],
    },
  },
  {
    name: "test_mcp_server",
    description:
      "Spawn a target stdio MCP server command (or probe an HTTP/SSE MCP endpoint) and perform a real JSON-RPC initialize + tools/list handshake, returning latency, discovered tool count, and any command/stderr errors.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Human-readable name for the server being tested.",
        },
        transport: {
          type: "string",
          enum: ["stdio", "http", "sse"],
          description: "Transport type (default: 'stdio').",
        },
        command: {
          type: "string",
          description: "Executable command for stdio servers (e.g. 'npx' or 'node').",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Command arguments for stdio servers.",
        },
        url: {
          type: "string",
          description: "Endpoint URL for http/sse servers.",
        },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional environment variables to pass when spawning the server.",
        },
        timeoutMs: {
          type: "number",
          description: "Handshake timeout in milliseconds (default: 8000).",
        },
      },
      required: [],
    },
  },
  {
    name: "repair_mcp_configs",
    description:
      "Detect and optionally rewrite fragile 'npx -y <pkg>@latest' MCP server configs to direct local node script paths (with automatic .fixmcp.bak backups) to eliminate -32001 startup timeouts.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: {
          type: "boolean",
          description:
            "If true, compute and return the rewrite plan without modifying files on disk (default: true).",
        },
        homeDir: {
          type: "string",
          description:
            "Optional custom home directory path to scan.",
        },
      },
      required: [],
    },
  },
  {
    name: "list_agent_config_paths",
    description:
      "List all supported AI coding agents (Claude Code, Claude Desktop, Cursor, VS Code, opencode, Codex CLI) and their expected MCP configuration file paths on the current operating system.",
    inputSchema: {
      type: "object",
      properties: {
        homeDir: {
          type: "string",
          description: "Optional custom home directory override.",
        },
      },
      required: [],
    },
  },
] as const;

export const MCP_RESOURCES = [
  {
    uri: "fixmcp://agents/supported",
    name: "Supported MCP Agent Config Targets",
    description:
      "List of supported AI agents, config formats, and file paths checked by fixmcp.",
    mimeType: "application/json",
  },
] as const;

export const MCP_PROMPTS = [
  {
    name: "troubleshoot-mcp-timeout",
    description:
      "Step-by-step diagnostic workflow for resolving MCP error -32001 (Request timed out) across local AI agents.",
    arguments: [
      {
        name: "serverName",
        description: "Optional name of the failing MCP server.",
        required: false,
      },
    ],
  },
] as const;

export async function runDiagnosticScan(opts: {
  skipHandshake?: boolean;
  timeoutMs?: number;
  homeDir?: string;
} = {}): Promise<ScanSummary> {
  const timeoutMs = Math.max(500, Number(opts.timeoutMs) || 8000);
  const { servers, configsFound } = discoverAll(
    opts.homeDir ? { homeDir: opts.homeDir } : undefined
  );
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

    let handshakeMs: number | undefined;
    let toolCount: number | undefined;

    if (entry.enabled !== false && !commandFatal) {
      if (entry.transport === "stdio" && !opts.skipHandshake) {
        const hs = await checkHandshake(entry, {
          timeoutMs,
          probeTools: true,
        });
        findings.push(...hs.findings);
        handshakeMs = hs.handshakeMs;
        toolCount = hs.toolCount;
      } else if (entry.transport !== "stdio") {
        findings.push(...(await checkNetwork(entry)));
      }
    }

    results.push({ entry, findings, handshakeMs, toolCount });
  }

  dupFindings.forEach((f, i) => results[i]?.findings.push(...f));

  return {
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
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export async function handleJsonRpcMessage(
  msg: JsonRpcRequest
): Promise<Record<string, unknown> | null> {
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
    return null;
  }

  // Notifications have no id
  if (msg.id === undefined) {
    return null;
  }

  const id = msg.id;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  try {
    switch (msg.method) {
      case "initialize": {
        const clientProtocol =
          typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : "2024-11-05";
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: clientProtocol,
            capabilities: {
              tools: { listChanged: false },
              resources: { listChanged: false },
              prompts: { listChanged: false },
            },
            serverInfo: {
              name: "fixmcp",
              version: "0.2.0",
            },
          },
        };
      }

      case "ping": {
        return {
          jsonrpc: "2.0",
          id,
          result: {},
        };
      }

      case "tools/list": {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: MCP_TOOLS,
          },
        };
      }

      case "resources/list": {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            resources: MCP_RESOURCES,
          },
        };
      }

      case "resources/read": {
        const uri = typeof params.uri === "string" ? params.uri : "";
        if (uri === "fixmcp://agents/supported") {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              contents: [
                {
                  uri,
                  mimeType: "application/json",
                  text: JSON.stringify(configTargets(), null, 2),
                },
              ],
            },
          };
        }
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: `Unknown resource URI: ${uri}`,
          },
        };
      }

      case "prompts/list": {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            prompts: MCP_PROMPTS,
          },
        };
      }

      case "prompts/get": {
        const name = typeof params.name === "string" ? params.name : "";
        if (name === "troubleshoot-mcp-timeout") {
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          const serverTarget =
            typeof args.serverName === "string" && args.serverName
              ? ` specifically focusing on "${args.serverName}"`
              : "";
          return {
            jsonrpc: "2.0",
            id,
            result: {
              description:
                "Diagnose and repair MCP error -32001 startup timeouts.",
              messages: [
                {
                  role: "user",
                  content: {
                    type: "text",
                    text: `Run diagnose_mcp_configs${serverTarget} to inspect all local agent MCP config files and test stdio handshakes. If any server uses fragile unpinned npx @latest commands or fails command resolution, run repair_mcp_configs to inspect or apply safe node path rewrites.`,
                  },
                },
              ],
            },
          };
        }
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: `Unknown prompt: ${name}`,
          },
        };
      }

      case "tools/call": {
        const toolName = typeof params.name === "string" ? params.name : "";
        const args = (params.arguments ?? {}) as Record<string, unknown>;

        if (toolName === "diagnose_mcp_configs") {
          const summary = await runDiagnosticScan({
            skipHandshake: Boolean(args.skipHandshake),
            timeoutMs:
              typeof args.timeoutMs === "number" ? args.timeoutMs : 8000,
            homeDir:
              typeof args.homeDir === "string" ? args.homeDir : undefined,
          });
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(summary, null, 2),
                },
              ],
              isError: false,
            },
          };
        }

        if (toolName === "test_mcp_server") {
          const transport =
            args.transport === "http" || args.transport === "sse"
              ? args.transport
              : "stdio";
          const entry: ServerEntry = {
            agent: "mcp-client",
            configFile: "inline",
            name: typeof args.name === "string" ? args.name : "target-server",
            transport,
            command:
              typeof args.command === "string" ? args.command : undefined,
            args: Array.isArray(args.args)
              ? args.args.map(String)
              : undefined,
            url: typeof args.url === "string" ? args.url : undefined,
            env:
              args.env && typeof args.env === "object"
                ? Object.fromEntries(
                    Object.entries(args.env as Record<string, unknown>).map(
                      ([k, v]) => [k, String(v)]
                    )
                  )
                : undefined,
            enabled: true,
          };

          const findings = [];
          findings.push(...(await checkCommand(entry)));
          findings.push(...checkEnv(entry));
          findings.push(...checkPatterns(entry));

          let handshakeMs: number | undefined;
          let toolCount: number | undefined;
          const commandFatal = findings.some(
            (f) => f.check === "command-resolution" && f.severity === "error"
          );

          if (!commandFatal) {
            if (transport === "stdio") {
              const hs = await checkHandshake(entry, {
                timeoutMs:
                  typeof args.timeoutMs === "number" ? args.timeoutMs : 8000,
                probeTools: true,
              });
              findings.push(...hs.findings);
              handshakeMs = hs.handshakeMs;
              toolCount = hs.toolCount;
            } else {
              findings.push(...(await checkNetwork(entry)));
            }
          }

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    { entry, findings, handshakeMs, toolCount },
                    null,
                    2
                  ),
                },
              ],
              isError: findings.some((f) => f.severity === "error"),
            },
          };
        }

        if (toolName === "repair_mcp_configs") {
          const dryRun = args.dryRun !== false;
          const { servers } = discoverAll(
            typeof args.homeDir === "string"
              ? { homeDir: args.homeDir }
              : undefined
          );
          const globalRoot = await npmGlobalRoot();
          if (!globalRoot) {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        error:
                          "Could not determine npm global root; cannot compute npx rewrite paths.",
                      },
                      null,
                      2
                    ),
                  },
                ],
                isError: true,
              },
            };
          }

          const plans = servers
            .map((e) => computeFix(e, globalRoot))
            .filter((p): p is NonNullable<typeof p> => p !== null);
          const skippedAgents = [
            ...new Set(
              servers
                .filter((e) => REPORT_ONLY.has(e.agent))
                .map((e) => e.agent)
            ),
          ];

          const applied =
            !dryRun && plans.length > 0 ? applyFix(plans) : [];

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      dryRun,
                      globalRoot,
                      plans: plans.map((p) => ({
                        agent: p.entry.agent,
                        configFile: p.entry.configFile,
                        server: p.entry.name,
                        newCommand: p.command,
                        newArgs: p.args,
                        explanation: p.explanation,
                      })),
                      applied,
                      skippedAgents,
                    },
                    null,
                    2
                  ),
                },
              ],
              isError: false,
            },
          };
        }

        if (toolName === "list_agent_config_paths") {
          const targets = configTargets(
            typeof args.homeDir === "string"
              ? { homeDir: args.homeDir }
              : undefined
          );
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(targets, null, 2),
                },
              ],
              isError: false,
            },
          };
        }

        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Unknown tool: ${toolName}`,
          },
        };
      }

      default: {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${msg.method}`,
          },
        };
      }
    }
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: (err as Error)?.message ?? "Internal server error",
      },
    };
  }
}

/**
 * Start the MCP stdio server and listen for newline-delimited JSON-RPC 2.0 messages.
 */
export async function runMcpServer(): Promise<number> {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }) + "\n"
      );
      return;
    }

    const response = await handleJsonRpcMessage(parsed);
    if (response) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  });

  return new Promise<number>((resolve) => {
    rl.on("close", () => resolve(0));
  });
}
