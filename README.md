<div align="center">

# fixmcp

**The MCP configuration doctor.**

[![CI](https://github.com/Ayoola-tech2024/fixmcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Ayoola-tech2024/fixmcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/fixmcp)](https://www.npmjs.com/package/fixmcp)
[![downloads](https://img.shields.io/npm/dm/fixmcp)](https://www.npmjs.com/package/fixmcp)
[![Node](https://img.shields.io/node/v/fixmcp)](https://www.npmjs.com/package/fixmcp)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

One command that finds every MCP config on your machine, handshakes every server for real,
and tells you exactly what's broken and how to fix it.

```bash
npx fixmcp
```

Works with **Claude Code · Claude Desktop · opencode · Cursor · VS Code · Codex CLI**
on **Windows · macOS · Linux** — zero install, nothing leaves your machine.

</div>

---

## The problem

Every MCP agent launches its servers at startup. If even one is misconfigured — an `npx` package that has to resolve from the registry, a command that isn't on PATH, an env var pointing at something unset — you get this:

```
MCP error -32001: Request timed out
```

No server name. No cause. Sometimes your tools just don't load; sometimes the whole agent hangs.

This tool was born from exactly that failure: four MCP servers timing out on *every* startup because their configs used `npx -y <pkg>@latest` — forcing an npm registry round-trip on each launch, which dies whenever the network is slow at boot. Diagnosing it took an afternoon; fixing it took minutes. fixmcp collapses that diagnosis to one command.

## Why static linting isn't enough

You can read a config and see nothing wrong — syntactically valid entries still time out at boot. So fixmcp doesn't just parse configs:

> **It spawns every stdio server and performs a real JSON-RPC `initialize` handshake plus `tools/list`** — the same conversation your agent has at startup. What fixmcp reports matches what actually happens.

It also counts startup latency and discovered tools per server, so you get `initialize OK in 3264ms, 29 tool(s)` instead of vibes.

## Sample output

```
fixmcp - MCP configuration doctor
configs: claude-code (~/.claude.json), opencode (~/.config/opencode/opencode.jsonc)

opencode
  ✓ energyai (http)
      ✓ [network] endpoint reachable (HTTP 405).
  ✓ local-browser (stdio)
      ✓ [command-resolution] command resolved: C:\Program Files\nodejs\node.exe
      ✓ [handshake] initialize OK in 3264ms, 29 tool(s).
  ✗ broken-server (stdio)
      ✗ [handshake] MCP handshake failed for "broken-server": timeout after 8000ms waiting for "initialize"
        no stderr output - the process may have died instantly or be stuck downloading.

all servers healthy
```

Machine-readable mode and exit codes (`0` healthy/warnings · `1` errors · `2` internal failure) make it pipeline- and agent-friendly:

```bash
npx fixmcp --json | jq '.errors'
```

## What it checks

| Check | stdio | http/sse | Catches |
|---|:-:|:-:|---|
| **command-resolution** | ✓ | | Commands not on PATH, missing node scripts, unpinned `npx pkg@latest` registry round-trips |
| **handshake** | ✓ | | Servers that spawn but never answer `initialize`; per-server latency + tool count |
| **network** | | ✓ | Unreachable endpoints (DNS, connection refused, timeout) with the OS error code |
| **env-check** | ✓ | ✓ | `${VAR}` references to variables not set on your machine |
| **patterns** | ✓ | ✓ | `npx` without `-y` (interactive-prompt hang), Claude Desktop silently ignoring `timeout` ([anthropics/claude-code#43791](https://github.com/anthropics/claude-code/issues/43791)) |
| **duplicates** | ✓ | ✓ | The same server name defined in multiple agents |

## Supported agents

| Agent | Config file | Auto-fix |
|---|---|:-:|
| Claude Code | `~/.claude.json` | ✓ |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` | ✓ |
| Cursor | `~/.cursor/mcp.json` | ✓ |
| VS Code | `%APPDATA%\Code\User\mcp.json` | ✓ |
| opencode | `~/.config/opencode/opencode.jsonc` | report-only* |
| Codex CLI | `~/.codex/config.toml` | report-only* |

\* These formats carry comments and formatting that naive rewrites would destroy, so fixmcp prints exact manual instructions instead of mangling them.

Windows gets first-class treatment: `.cmd`/`.bat` commands are routed through `cmd.exe` (Node ≥ 20 refuses to spawn them directly), PATH lookup honors `PATHEXT`, and child process trees are cleaned up via `taskkill /T`.

## The `--fix` rewrite

The classic failure mode this tool exists for:

```json
"context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp@latest"] }
```

`@latest` means npm hits the registry on **every agent startup**. Slow network at boot → 90-second timeout → `-32001`. With `--fix`, fixmcp rewrites entries like this to point directly at the already-installed script:

```json
"context7": {
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@upstash\\context7-mcp\\dist\\index.js"]
}
```

Zero network dependency at startup. Millisecond launches. Safety rails:

- A `<file>.fixmcp.bak` backup is written before any change
- Only plain-JSON agents (Claude Code/Desktop, Cursor, VS Code) are rewritten
- Entries whose package isn't installed globally are skipped — fixmcp never downloads anything
- Re-run `fixmcp` afterwards to verify the fix landed

Trade-off to know: after rewriting, update a server manually via `npm i -g <pkg>` when you want a new version — one deliberate update beats gambling on the registry every boot.

## For humans *and* agents

fixmcp is designed to be driven by both:

- **You:** `npx fixmcp` when something breaks
- **Your coding agents:** `npx fixmcp --json` + exit codes give Claude Code, Cursor, opencode etc. everything they need to diagnose and even self-heal their own MCP setups when you report an error

Add this to your project's `AGENTS.md` (or global agent instructions):

```markdown
When the user reports MCP server errors or timeouts, run:
  npx fixmcp --json
Read findings[].message/detail for exact causes. Apply config fixes with:
  npx fixmcp --fix
Then re-run without flags to verify.
```

## FAQ

<details>
<summary><b>Does fixmcp send my config anywhere?</b></summary>

No. Everything runs locally. Nothing is uploaded, ever.
</details>

<details>
<summary><b>Will it modify anything without asking?</b></summary>

It only writes files with <code>--fix</code>, always after a <code>.bak</code> backup, and only plain-JSON configs. Without <code>--fix</code> it is strictly read-only.
</details>

<details>
<summary><b>My server needs env vars/auth to start - will the handshake fail?</b></summary>

Possibly, and that's useful: if a server exits due to missing credentials, fixmcp shows its stderr tail as the failure detail so you see the actual cause instead of a bare timeout.
</details>

<details>
<summary><b>How long does a scan take?</b></summary>

A few seconds per stdio server (that's a real process launch + handshake). Use <code>--timeout &lt;ms&gt;</code> to tune, or <code>--no-handshake</code> for instant static-only checks.
</details>

## Development

```bash
git clone https://github.com/Ayoola-tech2024/fixmcp
cd fixmcp && npm install
npm test        # build + full suite, including real stdio handshake tests
node bin/fixmcp.js --help
```

Requires Node ≥ 20. TypeScript strict mode. Runtime dependencies: `jsonc-parser` and `smol-toml` — that's the entire list.

Contributions welcome: open an issue before large changes, keep PRs focused. Areas that especially need coverage: more agent config formats, more real-world footgun patterns for `checkPatterns`, and macOS/Linux path testing.

## License

[MIT](./LICENSE) © [Ayoola Damisile](https://github.com/Ayoola-tech2024)

<div align="center">

If fixmcp saved you a debugging session, consider leaving a star — it helps other people find it.

</div>
