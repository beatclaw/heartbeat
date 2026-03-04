#!/usr/bin/env node
// src/setup.ts — Interactive setup: config + MCP registration + service

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
  console.log('\n  BeatClaw Setup — Give your CLI a heartbeat\n')

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
    },
    telegram: {
      token: configToken,
      default_chat_id: chatId,
      allowed_users: [chatId],
    },
    heartbeat: {
      interval,
      active_hours: '09:00-22:00',
      checks: [
        'git diff --stat',
        "gh run list --limit 1 --json status --jq '.[0].status' | grep -v completed",
      ],
      prompt: [
        '1. Use telegram_read to check for new messages. Handle them.',
        '2. Use heartbeat_check to see if anything needs attention.',
        '3. If issues found, fix them and report via telegram_send.',
        '4. If nothing to do, just output HEARTBEAT_OK.',
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
  const dataDir = join(process.cwd(), 'data')
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }

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
      await testBot.api.sendMessage(chatId, "Hello! I'm alive. BeatClaw is ready.")
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

  if (cli === 'claude') {
    const cmd = `claude mcp add --transport http beatclaw ${url} --header "Authorization: Bearer ${token}"`
    const result = shellExec(cmd)
    if (result !== undefined) {
      log(`Registered MCP in Claude Code: ${cmd}`)
    } else {
      log(`Failed to register MCP. Run manually:\n  ${cmd}`)
    }
  } else {
    const cmd = `codex mcp add beatclaw --url ${url}`
    const result = shellExec(cmd)
    if (result !== undefined) {
      log(`Registered MCP in Codex CLI: ${cmd}`)
    } else {
      log(`Failed to register MCP. Run manually:\n  ${cmd}`)
    }
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
  const plistName = 'com.beatclaw.plist'
  const plistPath = join(HOME, 'Library', 'LaunchAgents', plistName)

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.beatclaw</string>
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
  <string>${join(cwd, 'data', 'beatclaw.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(cwd, 'data', 'beatclaw.error.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:${join(HOME, '.local', 'bin')}</string>
  </dict>
</dict>
</plist>`

  const laDir = join(HOME, 'Library', 'LaunchAgents')
  if (!existsSync(laDir)) {
    mkdirSync(laDir, { recursive: true })
  }
  writeFileSync(plistPath, plist, 'utf-8')
  shellExec(`launchctl load ${plistPath}`)
  log(`Installed launchd service: ${plistPath}`)
  log('  Start: launchctl load ~/Library/LaunchAgents/com.beatclaw.plist')
  log('  Stop:  launchctl unload ~/Library/LaunchAgents/com.beatclaw.plist')
}

async function installSystemd(cwd: string, nodePath: string): Promise<void> {
  const serviceDir = join(HOME, '.config', 'systemd', 'user')
  const servicePath = join(serviceDir, 'beatclaw.service')

  const service = `[Unit]
Description=BeatClaw Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=${cwd}
ExecStart=${nodePath} ${join(cwd, 'dist', 'index.js')}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target`

  if (!existsSync(serviceDir)) {
    mkdirSync(serviceDir, { recursive: true })
  }
  writeFileSync(servicePath, service, 'utf-8')
  shellExec('systemctl --user daemon-reload')
  shellExec('systemctl --user enable beatclaw')
  shellExec('systemctl --user start beatclaw')
  log(`Installed systemd service: ${servicePath}`)
  log('  Start:   systemctl --user start beatclaw')
  log('  Stop:    systemctl --user stop beatclaw')
  log('  Restart: systemctl --user restart beatclaw')
  log('  Logs:    journalctl --user -u beatclaw -f')
}

// === Entry ===

setup().catch((err) => {
  console.error('Setup failed:', err)
  process.exit(1)
})
