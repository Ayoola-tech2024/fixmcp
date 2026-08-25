import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeFix, applyFix } from "../dist/fix.js";
import { checkEnv } from "../dist/checks/env-check.js";
import { checkPatterns } from "../dist/checks/patterns.js";

const baseEntry = {
  agent: "claude-code",
  configFile: "",
  name: "x",
  transport: "stdio",
  enabled: true,
};

test("computeFix rewrites npx@latest to installed global script", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fixmcp-global-"));
  const pkgDir = path.join(root, "@scope", "tool");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "@scope/tool", bin: "./bin.js" })
  );
  writeFileSync(path.join(pkgDir, "bin.js"), "#!/usr/bin/env node");

  const entry = {
    ...baseEntry,
    configFile: path.join(root, "fake.json"),
    command: "npx",
    args: ["-y", "@scope/tool@latest", "--flag"],
  };
  const plan = computeFix(entry, root);
  assert.ok(plan);
  assert.equal(plan.command, process.execPath);
  assert.deepEqual(plan.args, [path.join(pkgDir, "bin.js"), "--flag"]);
});

test("applyFix rewrites config and writes backup", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fixmcp-cfg-"));
  const cfg = path.join(dir, ".claude.json");
  const oldBlock = JSON.stringify({ command: "npx", args: ["-y", "@scope/tool@latest"] });
  const newBlock = JSON.stringify({ command: "/fake/node", args: ["/fake/bin.js"] });
  writeFileSync(
    cfg,
    `{"mcpServers":{"tool":${oldBlock}}}`
  );

  const entry = {
    ...baseEntry,
    configFile: cfg,
    name: "tool",
    command: "npx",
    args: ["-y", "@scope/tool@latest"],
  };
  // monkey-plan: build expected new json manually to keep test hermetic
  const plan = {
    entry,
    command: "/fake/node",
    args: ["/fake/bin.js"],
    scriptPath: "/fake/bin.js",
    explanation: "test rewrite",
  };
  const applied = applyFix([plan]);
  assert.ok(applied.some((m) => m.includes("tool:")));
  assert.ok(readFileSync(cfg, "utf8").includes(newBlock));
  assert.ok(existsSync(cfg + ".fixmcp.bak"));
});

test("env-check flags unset ${VAR} references", () => {
  delete process.env.DEFINITELY_NOT_SET_12345;
  const findings = checkEnv({
    ...baseEntry,
    env: { KEY: "${DEFINITELY_NOT_SET_12345}" },
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "error");
});

test("patterns: npx without -y warns; claude-desktop timeout info", () => {
  const f1 = checkPatterns({ ...baseEntry, command: "npx", args: ["pkg"] });
  assert.ok(f1.some((f) => f.message.includes('"-y"')));
  const f2 = checkPatterns({
    ...baseEntry,
    agent: "claude-desktop",
    command: "node",
    timeout: 60,
  });
  assert.ok(f2.some((f) => f.severity === "info" && f.message.includes("#43791")));
});
