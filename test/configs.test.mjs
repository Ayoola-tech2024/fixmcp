import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverAll, parseConfigFile } from "../dist/configs.js";

function makeFakeHome() {
  const home = mkdtempSync(path.join(tmpdir(), "fixmcp-home-"));
  const appData = path.join(home, "appdata");
  mkdirSync(appData, { recursive: true });
  return { home, appData };
}

test("parses Claude Code mcpServers map", () => {
  const { home, appData } = makeFakeHome();
  const cfg = path.join(home, ".claude.json");
  writeFileSync(
    cfg,
    JSON.stringify({
      mcpServers: {
        local: { command: "npx", args: ["-y", "@scope/tool@latest"] },
        remote: { type: "http", url: "https://example.com/mcp" },
      },
    })
  );
  const servers = parseConfigFile("claude-code", cfg);
  assert.equal(servers.length, 2);
  assert.equal(servers[0].transport, "stdio");
  assert.deepEqual(servers[0].args, ["-y", "@scope/tool@latest"]);
  assert.equal(servers[1].transport, "http");
  void appData;
});

test("parses opencode jsonc incl. comments and enabled flag", () => {
  const { home, appData } = makeFakeHome();
  const dir = path.join(home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, "opencode.jsonc");
  writeFileSync(
    cfg,
    `{
      // my mcp setup
      "$schema": "x",
      "mcp": {
        "local-browser": {
          "type": "local",
          "command": ["node", "server.js"],
          "enabled": false
        },
        "cloudthing": { "type": "remote", "url": "https://api.example.com/mcp" }
      }
    }`
  );
  const servers = parseConfigFile("opencode", cfg);
  assert.equal(servers.length, 2);
  assert.equal(servers[0].command, "node");
  assert.deepEqual(servers[0].args, ["server.js"]);
  assert.equal(servers[0].enabled, false);
  assert.equal(servers[1].url, "https://api.example.com/mcp");
});

test("parses codex TOML", () => {
  const { home, appData } = makeFakeHome();
  const dir = path.join(home, ".codex");
  mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, "config.toml");
  writeFileSync(
    cfg,
    `[mcp_servers.search]\ncommand = "npx"\nargs = ["-y", "oxcast@latest"]\n\n[mcp_servers.search.env]\nKEY = "\${HOME_SET}"\n`
  );
  const servers = parseConfigFile("codex", cfg);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, "search");
  assert.equal(servers[0].command, "npx");
  assert.equal(servers[0].env?.KEY, "${HOME_SET}");
});

test("discoverAll finds only existing configs", () => {
  const { home, appData } = makeFakeHome();
  writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { a: { command: "node" } } })
  );
  const { servers, configsFound } = discoverAll({ homeDir: home, appData });
  assert.equal(configsFound.length, 1);
  assert.equal(configsFound[0].agent, "claude-code");
  assert.equal(servers.length, 1);
});
