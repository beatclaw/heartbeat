# BeatClaw

*Give your CLI a heartbeat*

A daemon that gives agentic coding CLIs (Claude Code, Codex CLI) a Telegram interface and autonomous heartbeat execution via MCP.

## How It Works

```
Telegram message → Daemon → CLI spawn (Claude Code / Codex CLI) → stdout streamed back → Telegram
                                        ↑
                              MCP tools: telegram_read, telegram_send, heartbeat_check
```

- **Telegram**: Real-time streaming via `sendMessageDraft` (Bot API 9.5)
- **Heartbeat**: Periodic cheap checks → CLI spawn only when changes detected
- **MCP**: SSE server on localhost, bearer token auth
- **Sandbox**: OS-level file write restriction (macOS sandbox-exec, Linux bubblewrap)
- **Sessions**: Separate user/heartbeat sessions with cross-context sharing

## Quick Start

```bash
# 1. Clone and build
git clone https://github.com/beatclaw/beatclaw.git
cd beatclaw
npm install && npm run build

# 2. Run interactive setup
npx beatclaw
# - Select CLI (Claude Code / Codex CLI)
# - Enter Telegram bot token
# - Detect chat ID
# - Set project directory
# - Configure heartbeat
# - Register MCP server + system service

# 3. Done — daemon starts automatically
```

## Supported CLIs

| CLI | Status | MCP Registration |
|-----|--------|------------------|
| Claude Code | v0.1 | `claude mcp add --transport http beatclaw ...` |
| Codex CLI | v0.1 | `codex mcp add beatclaw --url ...` |

## MCP Tools

| Tool | Description |
|------|-------------|
| `telegram_read` | Read buffered Telegram messages |
| `telegram_send` | Send a message to Telegram |
| `heartbeat_check` | Run configured health check commands |

## Configuration

See [config.yaml.example](config.yaml.example) for all options.

Key settings:

```yaml
agent:
  cli: claude          # claude | codex
  cwd: ~/projects/app  # agent working directory
  timeout: 300000      # 5 min CLI timeout
  session_max_turns: 100

heartbeat:
  interval: 30m
  active_hours: "09:00-22:00"
  checks:
    - "git diff --stat"
    - "gh run list --limit 1 --json status --jq '.[0].status' | grep -v completed"

sandbox:
  enabled: true
  allowed_paths:
    - ${agent.cwd}
    - /tmp
```

## Architecture

The daemon runs three subsystems:

1. **Telegram Bot** (grammY, long-polling) — receives messages, buffers them, triggers CLI
2. **MCP SSE Server** (localhost) — provides tools to the CLI during execution
3. **Heartbeat Timer** — runs cheap shell checks, spawns CLI only when changes detected

The CLI (Claude Code or Codex CLI) is the primary agent. BeatClaw only provides:
- Event detection (Telegram messages, heartbeat checks)
- Streaming relay (stdout → Telegram drafts)
- MCP tools (read/send messages, run checks)

## Streaming

Uses Telegram Bot API 9.5 `sendMessageDraft` for real-time streaming:
- CLI stdout chunks → `sendMessageDraft` (200ms throttle)
- CLI exits → `sendMessage` (finalized message)
- Fallback: `sendMessage` + `editMessageText` if drafts fail

## Security

| Layer | Mechanism |
|-------|-----------|
| MCP | `127.0.0.1` bind + bearer token |
| CLI spawn | `execFile()` (no shell injection) |
| Telegram | `allowed_users` whitelist |
| Config | `chmod 600` on config.yaml |
| Secrets | Best-effort regex redaction in stdout |
| Sandbox | OS-level file write restriction |

**Limitations:**
- Regex secret redaction is best-effort — not all patterns are caught
- Prompt injection defense depends on CLI's own safeguards
- sandbox-exec (macOS) only restricts file writes, not reads or network

## Service Management

```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.beatclaw.plist
launchctl unload ~/Library/LaunchAgents/com.beatclaw.plist

# Linux (systemd)
systemctl --user start beatclaw
systemctl --user stop beatclaw
journalctl --user -u beatclaw -f
```

## Roadmap

| Version | Features |
|---------|----------|
| v0.1 | Claude Code + Codex CLI + MCP + Telegram streaming + heartbeat + sandbox |
| v0.2 | Semantic memory (SQLite + BM25) + multi-agent |
| v0.3 | Discord, Slack channels + Windows sandbox |
| v0.4 | Token budget, dashboard |

## License

MIT
