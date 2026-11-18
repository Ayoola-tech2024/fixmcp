import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCommand } from "../dist/checks/command-resolution.js";
import { checkNetwork } from "../dist/checks/network-check.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("checkCommand warns on unpinned npx @latest package", async () => {
  const findings = await checkCommand({
    agent: "claude-code",
    configFile: "test",
    name: "context7",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp@latest"],
    enabled: true,
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "warn");
  assert.match(findings[0].message, /-32001/);
});

test("checkCommand accepts pinned npx package version", async () => {
  const findings = await checkCommand({
    agent: "claude-code",
    configFile: "test",
    name: "context7",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp@1.2.3"],
    enabled: true,
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "ok");
});

test("checkCommand reports error when command is missing from PATH", async () => {
  const findings = await checkCommand(
    {
      agent: "cursor",
      configFile: "test",
      name: "missing",
      transport: "stdio",
      command: "nonexistent-mcp-bin",
      args: [],
      enabled: true,
    },
    { whichFn: async () => null }
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "error");
  assert.match(findings[0].message, /not found on PATH/);
});

test("checkCommand reports error when node target script does not exist", async () => {
  const findings = await checkCommand(
    {
      agent: "vscode",
      configFile: "test",
      name: "broken-script",
      transport: "stdio",
      command: "node",
      args: [path.join(here, "does-not-exist-script.js")],
      enabled: true,
    },
    { whichFn: async () => process.execPath }
  );

  assert.ok(findings.some((f) => f.severity === "error" && f.message.includes("script not found")));
});

test("checkCommand ignores http/sse transports", async () => {
  const findings = await checkCommand({
    agent: "cursor",
    configFile: "test",
    name: "remote",
    transport: "http",
    url: "https://example.com/mcp",
    enabled: true,
  });

  assert.deepEqual(findings, []);
});

test("checkNetwork reports ok when endpoint responds", async () => {
  const findings = await checkNetwork(
    {
      agent: "cursor",
      configFile: "test",
      name: "remote",
      transport: "http",
      url: "https://example.com/mcp",
      enabled: true,
    },
    { fetchFn: async () => new Response("ok", { status: 200 }) }
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "ok");
  assert.match(findings[0].message, /HTTP 200/);
});

test("checkNetwork reports error with cause code when endpoint is unreachable", async () => {
  const findings = await checkNetwork(
    {
      agent: "cursor",
      configFile: "test",
      name: "down",
      transport: "sse",
      url: "http://127.0.0.1:59999/sse",
      enabled: true,
    },
    {
      fetchFn: async () => {
        const err = new Error("fetch failed");
        err.cause = { code: "ECONNREFUSED" };
        throw err;
      },
    }
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "error");
  assert.match(findings[0].message, /ECONNREFUSED/);
});

test("checkNetwork ignores stdio transports", async () => {
  const findings = await checkNetwork({
    agent: "claude-code",
    configFile: "test",
    name: "local",
    transport: "stdio",
    command: "node",
    args: [],
    enabled: true,
  });

  assert.deepEqual(findings, []);
});
