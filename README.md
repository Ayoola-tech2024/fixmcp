# fixmcp

**The MCP configuration doctor.** One command that finds every MCP config on your machine — Claude Code, Claude Desktop, opencode, Cursor, VS Code, Codex CLI — and tells you exactly which servers are broken, why, and how to fix them.

```bash
npx fixmcp
```

No more staring at `MCP error -32001: Request timed out` wondering which of your twelve servers is guilty.

## Why this exists

Every MCP agent launches its servers at startup. If even one server is misconfigured — a package that `npx` has to resolve from the registry, a command that isn't on PATH, an env var reference to something unset — you get vague timeout errors like:

```
MCP error -32001: Request timed out
```

...and the agent either starts without those tools or hangs. The error never tells you *which* server or *why*.

fixmcp was born from exactly this failure: four MCP servers, all timing out on every startup, all because their configs used `npx -y <pkg>@latest` — forcing an npm registry round-trip on **every single launch**, which dies whenever the network is slow at boot. The fix (rewriting configs to cached direct-node paths) took one afternoon once diagnosed. Diagnosing was the hard part. Now it's one command.

## What it does

1. **Discovers** MCP configs across six agents (skips files that don't exist)
2. **Runs static checks** — command resolution, env var references, known footguns, duplicate names
3. **Actually spawns each stdio server** and performs a real JSON-RPC `initialize` handshake + `tools/list` — the same thing your agent does at startup
4. **Reports** per-server findings with severities and exact causes
5. Optionally **rewrites fragile configs** (`--fix`) with a `.fixmcp.bak` backup first

Static linting can't catch "this server dies 4 seconds after spawning." A real handshake can.

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

Exit codes make it CI-friendly: `0` healthy/warnings only · `1` at least one error · `2` internal failure.

```bash
npx fixmcp --json | jq '.errors'   # machine-readable mode for pipelines
```

## What it checks

| Check | stdio | http/sse | Catches |
|---|---|---|---|
| command-resolution | ✓ | | Commands not on PATH, missing node scripts, unpinned `npx pkg@latest` registry round-trips |
| handshake | ✓ | | Servers that spawn but never answer `initialize`; counts tools via `tools/list` |
| network | | ✓ | Unreachable endpoints (DNS, refused, timeout) with the OS error code |
| env-check | ✓ | ✓ | `${VAR}` references to variables not set on your machine |
| patterns | ✓ | ✓ | `npx` without `-y` (interactive prompt hang), ignored Claude Desktop `timeout` field ([#43791](https://github.com/anthropics/claude-code/issues/43791)) |
| duplicates | ✓ | ✓ | Same server name defined in multiple agents |

## Supported agents

| Agent | Config file | Auto-fix |
|---|---|---|
| Claude Code | `~/.claude.json` | yes |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` | yes |
| Cursor | `~/.cursor/mcp.json` | yes |
| VS Code | `%APPDATA%\Code\User\mcp.json` | yes |
| opencode | `~/.config/opencode/opencode.jsonc` | report-only* |
| Codex CLI | `~/.codex/config.toml` | report-only* |

\* These formats carry comments/formatting that naive rewrites would destroy, so fixmcp reports exact manual instructions instead of mangling them.

Windows, macOS, and Linux are supported. On Windows, `.cmd`/`.bat` commands are correctly routed through `cmd.exe` (Node ≥ 20 refuses to spawn them directly) and child process trees are cleaned up via `taskkill /T`.

## The `--fix` rewrite

The classic failure mode this tool was built around:

```json
"context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp@latest"] }
```

`@latest` means npm hits the registry on **every agent startup**. Slow network at boot → 90-second timeout → `-32001`. fixmcp's `--fix` rewrites entries like this to point directly at the already-installed script:

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

Note: if you rewrite to direct-node paths, remember to re-run `npm i -g <pkg>` when you want to update that server — that trade (one manual update vs. every-boot registry gamble) is the whole point.

## FAQ

**Does fixmcp send my config anywhere?**
No. Everything runs locally. Nothing is uploaded, ever.

**Will it modify anything without asking?**
It only writes files with `--fix`, always after a `.bak` backup, and only plain-JSON configs. Without `--fix` it is strictly read-only.

**My server needs env vars/auth to start — will the handshake fail?**
If a server exits because of missing credentials, fixmcp shows its stderr tail as the failure detail so you can see the actual cause instead of a bare timeout.

**How is this different from just reading my configs?**
You can read a config and see nothing wrong — syntactically valid entries still time out at boot. fixmcp runs the same handshake your agent runs, so what it reports matches what actually happens.

## Development

```bash
npm install
npm test        # build + run test suite (includes real stdio handshake tests)
node bin/fixmcp.js --help
```

Requires Node ≥ 20. TypeScript strict mode; zero runtime dependencies beyond `jsonc-parser` and `smol-toml`.

## License

[MIT](./LICENSE) © Ayoola Damisile
