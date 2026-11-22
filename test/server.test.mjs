import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleJsonRpcMessage, MCP_TOOLS } from "../dist/server.js";
import { checkHandshake } from "../dist/checks/handshake.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(here, "..", "bin", "fixmcp.js");
const dummyMcp = path.join(here, "fixtures", "dummy-mcp.mjs");

test("MCP server: initialize returns capabilities and serverInfo", async () => {
  const res = await handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "glama-inspector", version: "1.0.0" },
    },
  });

  assert.ok(res);
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, "2024-11-05");
  assert.equal(res.result.serverInfo.name, "fixmcp");
  assert.ok(res.result.capabilities.tools);
  assert.ok(res.result.capabilities.resources);
  assert.ok(res.result.capabilities.prompts);
});

test("MCP server: tools/list returns all 4 diagnostic tools", async () => {
  const res = await handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });

  assert.ok(res);
  assert.equal(res.id, 2);
  assert.equal(res.result.tools.length, MCP_TOOLS.length);
  const names = res.result.tools.map((t) => t.name);
  assert.deepEqual(names, [
    "diagnose_mcp_configs",
    "test_mcp_server",
    "repair_mcp_configs",
    "list_agent_config_paths",
  ]);
});

test("MCP server: resources/list and resources/read return supported agents", async () => {
  const listRes = await handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "resources/list",
  });
  assert.equal(listRes.result.resources.length, 1);
  assert.equal(listRes.result.resources[0].uri, "fixmcp://agents/supported");

  const readRes = await handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "resources/read",
    params: { uri: "fixmcp://agents/supported" },
  });
  const parsed = JSON.parse(readRes.result.contents[0].text);
  assert.equal(parsed.length, 6);
});

test("MCP server: prompts/list and prompts/get return troubleshooting prompt", async () => {
  const listRes = await handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 5,
    method: "prompts/list",
  });
  assert.equal(listRes.result.prompts.length, 1);

  const getRes = await handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 6,
    method: "prompts/get",
    params: {
      name: "troubleshoot-mcp-timeout",
      arguments: { serverName: "context7" },
    },
  });
  assert.ok(
    getRes.result.messages[0].content.text.includes('focusing on "context7"')
  );
});

test("MCP server: tools/call test_mcp_server handshakes a real target server", async () => {
  const res = await handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "test_mcp_server",
      arguments: {
        name: "dummy-fixture",
        transport: "stdio",
        command: process.execPath,
        args: [dummyMcp],
      },
    },
  });

  assert.equal(res.result.isError, false);
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.toolCount, 1);
  assert.ok(payload.findings.some((f) => f.check === "handshake" && f.severity === "ok"));
});

test("MCP server: live stdio handshake against `fixmcp serve` binary", async () => {
  const { findings, toolCount } = await checkHandshake(
    {
      agent: "claude-code",
      configFile: "test",
      name: "fixmcp-self",
      transport: "stdio",
      command: process.execPath,
      args: [binPath, "serve"],
      enabled: true,
    },
    { timeoutMs: 10000, probeTools: true }
  );

  const ok = findings.find((f) => f.severity === "ok");
  assert.ok(ok, "expected fixmcp serve to complete stdio initialize + tools/list");
  assert.equal(toolCount, 4);
});
