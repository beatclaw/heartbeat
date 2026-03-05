#!/usr/bin/env node
// src/setup.ts — Interactive setup: config + MCP registration + service

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'
import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { select, input, confirm } from '@inquirer/prompts'
import { stringify as stringifyYaml } from 'yaml'
import { Bot } from 'grammy'

const HOME = homedir()

// === Helpers ===

function log(msg: string): void {
  console.log(`\n  ${msg}`)
}

function generateToken(): string {
  return randomBytes(32).toString('hex')
}

function expandPath(p: string): string {
  return p.replace(/^~/, HOME)
}

function shellExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 10_000 }).trim()
  } catch {
    return ''
  }
}

// === Main Setup ===

async function setup(): Promise<void> {
  console.log('\n  Heartbeat Setup — Give your CLI a heartbeat\n')

  // Check if config already exists
  const configPath = join(process.cwd(), 'config.yaml')
  if (existsSync(configPath)) {
    const overwrite = await confirm({
      message: 'config.yaml already exists. Overwrite?',
      default: false,
    })
    if (!overwrite) {
      log('Setup cancelled.')
      return
    }
  }

  // 1. Select CLI
  const cli = await select({
    message: 'Which CLI tool do you use?',
    choices: [
      { name: 'Claude Code', value: 'claude' },
      { name: 'Codex CLI', value: 'codex' },
    ],
  })

  // 2. Telegram bot token
  log('Create a Telegram bot via @BotFather: https://t.me/BotFather')
  log('Set the token as an environment variable (recommended):')
  log('  export TELEGRAM_TOKEN="your-bot-token"')
  log('Or enter it directly (will be stored in config.yaml)')

  const useEnv = await confirm({
    message: 'Use environment variable TELEGRAM_TOKEN?',
    default: true,
  })

  let telegramToken: string
  let configToken: string

  if (useEnv) {
    configToken = 'env:TELEGRAM_TOKEN'
    telegramToken = process.env.TELEGRAM_TOKEN ?? ''
    if (!telegramToken) {
      telegramToken = await input({
        message: 'TELEGRAM_TOKEN not set. Enter token for detection (not saved to config):',
      })
    }
  } else {
    telegramToken = await input({ message: 'Enter Telegram bot token:' })
    configToken = telegramToken
    log('Warning: Token stored as plaintext in config.yaml. Use env: reference instead.')
  }

  // 3. Detect chat ID
  let chatId: number | null = null

  if (telegramToken) {
    log('Detecting chat ID... Send /start to your bot now.')

    const detectBot = new Bot(telegramToken)
    const detected = await Promise.race([
      new Promise<number>((res) => {
        detectBot.on('message', (ctx) => {
          if (ctx.from) {
            res(ctx.chat.id)
          }
        })
        detectBot.start()
      }),
      new Promise<null>((res) => setTimeout(() => res(null), 30_000)),
    ])

    detectBot.stop()

    if (detected) {
      chatId = detected
      log(`Detected chat ID: ${chatId}`)
    } else {
      log('Auto-detection timed out.')
    }
  }

  if (!chatId) {
    const manualId = await input({ message: 'Enter Telegram chat ID manually:' })
    chatId = parseInt(manualId, 10)
  }

  // 4. Project directory
  const cwd = await input({
    message: 'Project directory (agent working directory):',
    default: '~/projects/my-app',
  })
  const resolvedCwd = expandPath(cwd)

  // 5. Heartbeat interval
  const interval = await input({
    message: 'Heartbeat interval (e.g., 30m, 1h, 15m):',
    default: '30m',
  })

  // 6. MCP port
  const portStr = await input({
    message: 'MCP server port:',
    default: '39100',
  })
  const port = parseInt(portStr, 10)

  // 7. Generate bearer token
  const bearerToken = generateToken()

  // 8. Build config
  const config = {
    agent: {
      cli,
      cwd,
      timeout: 300000,
      session_max_turns: 100,
      kill_grace: 5000,
      cross_context_max_chars: 500,
    },
    telegram: {
      token: configToken,
      default_chat_id: chatId,
      allowed_users: [chatId],
    },
    heartbeat: {
      interval,
      checks: [
        'git diff --stat',
        "gh run list --limit 1 --json status --jq '.[0].status' | grep -v completed",
      ],
      check_timeout: 30000,
      prompt: [
        'You are an autonomous heartbeat agent. Each cycle has three phases.',
        '',
        'Phase 1 — Inbox:',
        '1. telegram_read — check for new messages. Create todos for any tasks or requests.',
        '2. heartbeat_check — run health checks. Create todos for anything needing action.',
        '',
        'Phase 2 — Proactive Discovery:',
        'Generate NEW todos by actively investigating these areas. Do NOT skip this phase.',
        'Use memory_search and web search to gather context before creating todos.',
        '',
        'A) User Needs Anticipation:',
        "   - Search your memories (memory_search) for the user's ongoing projects, interests, and recent requests.",
        '   - Infer what the user might need next — follow-ups, reminders, research, or actions.',
        '   - Create todos for anything useful you discover. Be a thoughtful assistant, not a passive one.',
        '',
        'B) Heartbeat Self-Improvement:',
        '   - Review the heartbeat system itself (code, config, prompts, architecture).',
        '   - Look for bugs, missing features, performance issues, or UX improvements.',
        "   - Create todos for concrete improvement ideas (not vague \"could be better\").",
        '',
        'C) Claw Ecosystem Watch:',
        '   - Search the web for updates on: OpenClaw, ClaudeClaw, Claude Code, and similar AI coding tools.',
        '   - Look for new features, architectural patterns, or ideas worth adopting in BeatClaw/Heartbeat.',
        "   - Create a todo only if there's a specific, actionable learning or feature to investigate.",
        '',
        'D) Breaking News Alert (URGENT ONLY):',
        '   - Search for major breaking news in: global events, IT industry, AI/LLM developments.',
        '   - Only create a todo + immediately telegram_send if truly urgent (market crash, major AI release, security incident, etc.).',
        '   - Do NOT report routine news. The bar is: "Would the user want to be interrupted for this?"',
        '',
        'MANDATORY: You MUST check ALL four areas (A, B, C, D) every cycle. Do NOT skip any.',
        'Use memory_save to track what you found and when, to avoid repeating the same searches across cycles.',
        '',
        'Phase 3 — Execution:',
        '3. todo_list — get all pending todos.',
        '4. Process todos from highest to lowest priority:',
        '   a. todo_update → in_progress',
        '   b. Do the work (web search, code analysis, research, etc.)',
        '   c. todo_update → done with result summary',
        '   d. telegram_send to report the result (skip for minor items)',
        '   e. Next pending todo immediately.',
        '5. If nothing was discovered and no pending todos exist, output only: HEARTBEAT_OK',
      ].join('\n'),
    },
    mcp: {
      port,
      token: bearerToken,
    },
    sandbox: {
      enabled: true,
      allowed_paths: ['${agent.cwd}', '/tmp'],
      extra_paths: [] as string[],
    },
    streaming: {
      throttle: 200,
      fallback: true,
    },
  }

  // 9. Write config.yaml
  writeFileSync(configPath, stringifyYaml(config), 'utf-8')
  chmodSync(configPath, 0o600)
  log(`Written: config.yaml (chmod 600)`)

  // 10. Ensure data directory
  mkdirSync(join(process.cwd(), 'data'), { recursive: true })

  // 11. Copy system prompt template to project
  const templateFile = cli === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'
  const templateSrc = join(process.cwd(), 'templates', templateFile)
  const templateDst = join(resolvedCwd, templateFile)

  if (existsSync(templateSrc) && existsSync(resolvedCwd)) {
    if (existsSync(templateDst)) {
      const overwritePrompt = await confirm({
        message: `${templateFile} already exists in ${cwd}. Overwrite?`,
        default: false,
      })
      if (overwritePrompt) {
        copyFileSync(templateSrc, templateDst)
        log(`Copied: ${templateFile} → ${cwd}/${templateFile}`)
      }
    } else {
      copyFileSync(templateSrc, templateDst)
      log(`Copied: ${templateFile} → ${cwd}/${templateFile}`)
    }
  } else {
    log(`Note: Copy ${templateFile} to your project manually from templates/`)
  }

  // 12. Register MCP server in CLI config
  log('Registering MCP server...')
  await registerMcp(cli, port, bearerToken)

  // 13. Register system service
  const registerService = await confirm({
    message: 'Register as system service (auto-start on boot)?',
    default: true,
  })

  if (registerService) {
    await installService()
  }

  // 14. Test message
  if (telegramToken && chatId) {
    const testBot = new Bot(telegramToken)
    try {
      await testBot.api.sendMessage(chatId, "Hello! I'm alive. Heartbeat is ready.")
      log('Test message sent successfully!')
    } catch (err) {
      log(`Failed to send test message: ${(err as Error).message}`)
    }
  }

  log('Setup complete! Start the daemon with: npm start')
  log('Or if registered as a service, it will start automatically.')
}

// === MCP Registration ===

async function registerMcp(cli: string, port: number, token: string): Promise<void> {
  const url = `http://localhost:${port}/sse`

  const cmd = cli === 'claude'
    ? `claude mcp add --transport http heartbeat ${url} --header "Authorization: Bearer ${token}"`
    : `codex mcp add heartbeat --url ${url}`

  try {
    execSync(cmd, { encoding: 'utf-8', timeout: 10_000 })
    log(`Registered MCP: ${cmd}`)
  } catch {
    log(`Failed to register MCP. Run manually:\n  ${cmd}`)
  }
}

// === System Service ===

async function installService(): Promise<void> {
  const cwd = process.cwd()
  const nodePath = shellExec('which node') || '/usr/local/bin/node'
  const os = platform()

  if (os === 'darwin') {
    await installLaunchd(cwd, nodePath)
  } else if (os === 'linux') {
    await installSystemd(cwd, nodePath)
  } else {
    log(`Unsupported platform for service registration: ${os}`)
  }
}

async function installLaunchd(cwd: string, nodePath: string): Promise<void> {
  const plistName = 'com.beatclaw.heartbeat.plist'
  const plistPath = join(HOME, 'Library', 'LaunchAgents', plistName)

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.beatclaw.heartbeat</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${join(cwd, 'dist', 'index.js')}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${cwd}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(cwd, 'data', 'heartbeat.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(cwd, 'data', 'heartbeat.error.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:${join(HOME, '.local', 'bin')}</string>
  </dict>
</dict>
</plist>`

  mkdirSync(join(HOME, 'Library', 'LaunchAgents'), { recursive: true })
  writeFileSync(plistPath, plist, 'utf-8')
  shellExec(`launchctl load ${plistPath}`)
  log(`Installed launchd service: ${plistPath}`)
  log('  Start: launchctl load ~/Library/LaunchAgents/com.beatclaw.heartbeat.plist')
  log('  Stop:  launchctl unload ~/Library/LaunchAgents/com.beatclaw.heartbeat.plist')
}

async function installSystemd(cwd: string, nodePath: string): Promise<void> {
  const serviceDir = join(HOME, '.config', 'systemd', 'user')
  const servicePath = join(serviceDir, 'heartbeat.service')

  const service = `[Unit]
Description=Heartbeat Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=${cwd}
ExecStart=${nodePath} ${join(cwd, 'dist', 'index.js')}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target`

  mkdirSync(serviceDir, { recursive: true })
  writeFileSync(servicePath, service, 'utf-8')
  shellExec('systemctl --user daemon-reload')
  shellExec('systemctl --user enable heartbeat')
  shellExec('systemctl --user start heartbeat')
  log(`Installed systemd service: ${servicePath}`)
  log('  Start:   systemctl --user start heartbeat')
  log('  Stop:    systemctl --user stop heartbeat')
  log('  Restart: systemctl --user restart heartbeat')
  log('  Logs:    journalctl --user -u heartbeat -f')
}

// === Entry ===

setup().catch((err) => {
  console.error('Setup failed:', err)
  process.exit(1)
})
