# Contributing to Heartbeat

## Development Setup

```bash
git clone https://github.com/beatclaw/heartbeat.git
cd heartbeat
npm install
npm run build
npm run dev   # watch mode
```

## Project Structure

```
src/
  index.ts    # Daemon: telegram + MCP SSE + heartbeat + CLI spawner + streaming
  cli.ts      # Per-CLI command builders (Claude Code, Codex CLI)
  sandbox.ts  # OS sandbox wrapper (macOS sandbox-exec, Linux bubblewrap)
  setup.ts    # Interactive setup: config + MCP registration + service
templates/
  CLAUDE.md   # Agent system prompt for Claude Code
  AGENTS.md   # Agent system prompt for Codex CLI
```

## Code Style

- **TypeScript strict mode** — no `any` except where unavoidable (e.g., grammY raw API)
- **Immutability** — never mutate objects; use spread to create new ones
- **No mutation of arrays** — use `[...arr, item]` instead of `push`
- **Conventional commits** — `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`

## Adding a New CLI

1. Create a new class implementing `CliBuilder` in `src/cli.ts`
2. Add it to the `getCliBuilder` factory switch
3. Add the CLI's system prompt template to `templates/`
4. Update `src/setup.ts` to handle MCP registration for the new CLI

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`feat/your-feature`)
3. Make your changes with tests where applicable
4. Ensure `npm run build` passes
5. Submit a PR with a clear description

## Reporting Issues

Open an issue at [github.com/beatclaw/heartbeat/issues](https://github.com/beatclaw/heartbeat/issues) with:
- OS and Node.js version
- CLI tool and version (Claude Code / Codex CLI)
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs from `data/heartbeat.log`

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
