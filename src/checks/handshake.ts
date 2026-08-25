import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import type { Finding, ServerEntry } from "../types.js";

export interface HandshakeOptions {
  timeoutMs?: number;
  /** also request tools/list and count tools */
  probeTools?: boolean;
}

interface JsonRpcMsg {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: unknown;
  params?: Record<string, unknown>;
}

function spawnServer(entry: ServerEntry): ChildProcess {
  const command = entry.command!;
  const args = entry.args ?? [];
  const env = { ...process.env, ...(entry.env ?? {}) };
  if (
    process.platform === "win32" &&
    /\.(cmd|bat)$/i.test(command)
  ) {
    // Node >=20 refuses to spawn .cmd directly; route through cmd.exe
    return spawn("cmd.exe", ["/d", "/s", "/c", command, ...args], { env });
  }
  return spawn(command, args, { env });
}

/**
 * Spawns a stdio MCP server and performs a real JSON-RPC initialize
 * handshake, optionally followed by tools/list. This is the exact
 * interaction agents rely on, so it catches what static checks cannot.
 */
export async function checkHandshake(
  entry: ServerEntry,
  opts: HandshakeOptions = {}
): Promise<{ findings: Finding[]; handshakeMs?: number; toolCount?: number }> {
  if (entry.transport !== "stdio" || !entry.command || entry.enabled === false) {
    return { findings: [] };
  }
  const timeoutMs = opts.timeoutMs ?? 8000;
  const started = Date.now();
  let child: ChildProcess;
  try {
    child = spawnServer(entry);
  } catch (err) {
    return {
      findings: [
        {
          check: "handshake",
          severity: "error",
          message: `failed to spawn "${entry.command}": ${(err as Error).message}`,
        },
      ],
    };
  }

  let stderrTail = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-600);
  });

  const rl = readline.createInterface({ input: child.stdout! });
  const pending = new Map<
    number,
    { resolve: (v: JsonRpcMsg) => void; timer: NodeJS.Timeout }
  >();

  const request = (id: number, method: string, params: unknown) =>
    new Promise<JsonRpcMsg>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms waiting for "${method}"`));
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      child.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
      );
    });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed) as JsonRpcMsg;
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        p.resolve(msg);
      }
    } catch {
      /* non-JSON stdout noise - tolerate */
    }
  });

  try {
    await request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fixmcp", version: "0.1.0" },
    });
    child.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n"
    );
    const handshakeMs = Date.now() - started;

    let toolCount: number | undefined;
    if (opts.probeTools !== false) {
      try {
        const res = await request(2, "tools/list", {});
        const tools = (res.result as { tools?: unknown[] })?.tools;
        toolCount = Array.isArray(tools) ? tools.length : undefined;
      } catch {
        /* some servers skip tools/list - not fatal */
      }
    }

    return {
      findings: [
        {
          check: "handshake",
          severity: "ok",
          message: `initialize OK in ${handshakeMs}ms${toolCount !== undefined ? `, ${toolCount} tool(s)` : ""}.`,
        },
      ],
      handshakeMs,
      toolCount,
    };
  } catch (err) {
    return {
      findings: [
        {
          check: "handshake",
          severity: "error",
          message: `MCP handshake failed for "${entry.name}": ${(err as Error).message}`,
          detail:
            stderrTail.trim().length > 0
              ? `server stderr: ${stderrTail.trim()}`
              : "no stderr output - the process may have died instantly or be stuck downloading.",
        },
      ],
    };
  } finally {
    rl.close();
    if (!child.killed) {
      if (process.platform === "win32" && child.pid) {
        // kill the whole tree (npx -> node -> ...)
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else {
        child.kill("SIGKILL");
      }
    }
  }
}
