import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkHandshake } from "../dist/checks/handshake.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dummy = path.join(here, "fixtures", "dummy-mcp.mjs");

test("handshake succeeds against a real stdio MCP server", async () => {
  const { findings, handshakeMs, toolCount } = await checkHandshake({
    agent: "claude-code",
    configFile: "test",
    name: "dummy",
    transport: "stdio",
    command: process.execPath,
    args: [dummy],
    enabled: true,
  }, { timeoutMs: 10000 });

  const ok = findings.find((f) => f.severity === "ok");
  assert.ok(ok, "expected an ok finding");
  assert.ok((handshakeMs ?? 0) < 10000);
  assert.equal(toolCount, 1);
});

test("handshake reports error for a dead command", async () => {
  const { findings } = await checkHandshake({
    agent: "claude-code",
    configFile: "test",
    name: "broken",
    transport: "stdio",
    command: process.execPath,
    args: [path.join(here, "does-not-exist.mjs")],
    enabled: true,
  }, { timeoutMs: 5000 });

  assert.ok(findings.some((f) => f.severity === "error"));
});
