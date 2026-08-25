// Minimal stdio MCP server for tests: answers initialize + tools/list.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (typeof msg?.id !== "number" || typeof msg?.method !== "string") return;
  if (msg.method === "initialize") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion:
            msg.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "dummy-mcp", version: "0.0.1" },
        },
      }) + "\n"
    );
  } else if (msg.method === "tools/list") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echoes back its input text.",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: [],
              },
            },
          ],
        },
      }) + "\n"
    );
  }
});
