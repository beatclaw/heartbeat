# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Heartbeat (`@beatclaw/heartbeat`) — a daemon that gives agentic coding CLIs (Claude Code, Codex CLI) a Telegram interface and autonomous heartbeat execution. When a Telegram message arrives, it spawns the CLI and streams stdout back in real time (Bot API 9.5 `sendMessageDraft`). Periodic heartbeats detect changes and auto-trigger the CLI when needed.

## Build / Run

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm run dev          # Watch mode compilation
npm start            # Run daemon (requires config.yaml)
npm run setup        # Interactive setup wizard
```

Build verification: passes if `npm run build` completes without errors. No separate lint/test scripts.

## Architecture

```
Telegram ← grammY long-polling → Daemon (index.ts) ← MCP SSE (localhost:39100) → CLI
                                      ↓
                                Heartbeat timer → shell checks → CLI spawn (on change detected)
```

The daemon runs three concurrent subsystems:
1. **Telegram Bot** (grammY) — message receive/buffer, result streaming
2. **MCP SSE Server** (`@modelcontextprotocol/sdk`) — exposes `telegram_read`, `telegram_send`, `heartbeat_check` tools to the CLI. Bearer token auth, bound to `127.0.0.1`
3. **Heartbeat Timer** — runs cheap shell checks at configured intervals, spawns CLI only when output is produced

## Core Data Flow

### Message → CLI → Streaming

1. Telegram message received → immutable append to `messageBuffer`
2. `spawnCli('user')` — spawn CLI process (`--dangerously-skip-permissions --output-format stream-json`)
3. Parse stdout: `CliBuilder.extractText()` extracts text from JSON stream
4. Extracted text → real-time streaming via `sendMessageDraft()` (throttle 200ms)
5. CLI exits → send final message via `sendMessage()` (secrets auto-redacted)

### Session Management

- **Separate user/heartbeat sessions** — each maintains independent `session_id` and turn count
- **Session continuity** — after first run, uses `--continue` to resume existing session. Falls back to fresh session on failure
- **Cross-context** — user session results injected read-only into heartbeat prompts and vice versa (500 char limit)
- **HEARTBEAT_OK** — if heartbeat CLI outputs only this string, Telegram message dispatch is suppressed

## Source File Roles

| File | Role |
|------|------|
| `src/index.ts` | Main daemon — integrates three subsystems, CLI spawner, streaming, session/context/message buffer management |
| `src/cli.ts` | `CliBuilder` interface + implementations. Claude Code parses `stream-json` format, Codex parses mixed JSON/plaintext |
| `src/sandbox.ts` | OS sandbox wrapper — macOS: `sandbox-exec` (restricts file writes only), Linux: `bubblewrap` (ro-bind + allowed paths only) |
| `src/setup.ts` | Interactive setup — config.yaml generation, chat ID auto-detection, MCP registration, system service (launchd/systemd) installation |
| `templates/CLAUDE.md` | Agent system prompt for Claude Code |
| `templates/AGENTS.md` | Agent system prompt for Codex CLI |

## Configuration

`config.yaml` (gitignored, see `config.yaml.example`):
- `agent`: CLI type (`claude`|`codex`), cwd, timeout, max session turns
- `telegram`: bot token (`env:` prefix to reference env vars), default_chat_id, allowed_users whitelist
- `heartbeat`: interval (`30m`, `1h`, etc.), active_hours, check command array, prompt
- `mcp`: port, bearer token
- `sandbox`: enabled flag, allowed_paths (`${agent.cwd}` substitution supported), extra_paths
- `streaming`: throttle (ms), fallback

## Adding a New CLI

1. Add a `CliBuilder` implementation class in `src/cli.ts` — implement `buildArgs`, `parseSessionId`, `extractText`
2. Register in the `getCliBuilder()` factory switch
3. Add a system prompt in `templates/`
4. Add to the CLI selection list in `src/setup.ts` and the `registerMcp()` registration command

## Telegram Command Management

When adding/modifying/removing Telegram commands registered via `bot.command()` in `src/index.ts`, **always update the `/help` command response text as well**. The `/help` handler is in the `bot.command('help', ...)` block and displays the supported command list to users.

Current commands:
- `/help` — Show help
- `/ping` — Check bot responsiveness
- `/todo <content>` — Add a new todo
- `/todos` — List pending/in-progress todos
- `/clear` — Remove completed/failed todos
- `/chatid` — Show Chat ID / User ID

## Code Style

- TypeScript strict mode, ESM (`"type": "module"`, `NodeNext` resolution)
- Immutability — no object/array mutation, create new objects via spread (`messageBuffer = [...messageBuffer, item]`)
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`

## Runtime Data

`data/` directory (gitignored):
- `sessions.json` — session IDs + turn counts (separate user/heartbeat)
- `context.json` — cross-context sharing (lastUser, lastHeartbeat summaries)
- `pending_messages.json` — message backup for crash safety
- `heartbeat.log`, `heartbeat.error.log` — service logs
