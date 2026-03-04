#!/usr/bin/env node
// src/index.ts — Daemon: telegram + MCP SSE + heartbeat + spawner + streaming

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn, exec, execSync, type ChildProcess } from 'node:child_process'
import { Bot } from 'grammy'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { getCliBuilder, type CliBuilder, createActivityExtractor } from './cli.js'
import { wrapWithSandbox, type SandboxConfig } from './sandbox.js'
import { loadTodos, addTodo, updateTodo, getNextTodo, clearDone, recoverStuck } from './todos.js'

// === Config ===

interface TelegramMessage {
  from: string
  text: string
  chat_id: number
  message_id: number
}

interface Config {
  agent: { cli: string; cwd: string; timeout: number; session_max_turns: number; kill_grace: number; cross_context_max_chars: number }
  telegram: { token: string; default_chat_id: number; allowed_users: number[] }
  heartbeat: { interval: string; checks: string[]; check_timeout: number; prompt: string }
  mcp: { port: number; token: string }
  sandbox: SandboxConfig
  streaming: { throttle: number; fallback: boolean }
}

interface Sessions {
  user: { id: string | null; turns: number }
  heartbeat: { id: string | null; turns: number }
}

interface CrossContext {
  lastHeartbeat: string
  lastUser: string
}

function resolveEnvValue(val: string): string {
  if (val.startsWith('env:')) {
    const envKey = val.slice(4)
    const envVal = process.env[envKey]
    if (!envVal) throw new Error(`Environment variable ${envKey} not set`)
    return envVal
  }
  return val
}

const CONFIG_PATH = join(process.cwd(), 'config.yaml')
const DATA_DIR = join(process.cwd(), 'data')

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    console.error('config.yaml not found. Run "npx @beatclaw/heartbeat" to set up.')
    process.exit(1)
  }
  const raw = parseYaml(readFileSync(CONFIG_PATH, 'utf-8')) as Config
  return {
    ...raw,
    telegram: { ...raw.telegram, token: resolveEnvValue(raw.telegram.token) },
    agent: { ...raw.agent, cwd: raw.agent.cwd.replace(/^~/, homedir()) },
  }
}

// === Data persistence ===

function loadJson<T>(filename: string, fallback: T): T {
  const p = join(DATA_DIR, filename)
  if (!existsSync(p)) return fallback
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function saveJson(filename: string, data: unknown): void {
  const p = join(DATA_DIR, filename)
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8')
  chmodSync(p, 0o600)
}

// === Secret redaction (best-effort) ===

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /ghp_[a-zA-Z0-9]{36,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /gho_[a-zA-Z0-9]{36,}/g,
  /xoxb-[a-zA-Z0-9-]+/g,
]

function redactSecrets(text: string): string {
  let result = text
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]')
  }
  return result
}

// === State ===

const config = loadConfig()
const cliBuilder: CliBuilder = getCliBuilder(config.agent.cli)

let messageBuffer: readonly TelegramMessage[] = []
let isProcessing = false
let activeChild: ChildProcess | null = null

let sessions: Sessions = loadJson('sessions.json', {
  user: { id: null, turns: 0 },
  heartbeat: { id: null, turns: 0 },
})

let context: CrossContext = loadJson('context.json', {
  lastHeartbeat: '',
  lastUser: '',
})

// === Telegram Bot ===

const bot = new Bot(config.telegram.token)

function isAllowed(userId: number): boolean {
  return config.telegram.allowed_users.includes(userId)
}

bot.command('help', async (ctx) => {
  const msg = [
    '📖 <b>Help</b>',
    '',
    '/help — Show this help',
    '/ping — Check bot status',
    '/todo &lt;text&gt; — Add a new todo',
    '/todos — List active todos',
    '/clear — Remove completed todos',
    '/chatid — Show Chat ID / User ID',
    '/stop — Stop current AI task',
    '/exit — Shut down the daemon (also: /shutdown, /quit)',
    '',
    'Send any message to trigger the AI agent.',
  ].join('\n')
  await ctx.reply(msg, { parse_mode: 'HTML' })
})

bot.command('chatid', async (ctx) => {
  const msg = [
    '🆔 <b>Chat Info</b>',
    '',
    `Chat: <code>${ctx.chat.id}</code>`,
    `User: <code>${ctx.from?.id}</code>`,
  ].join('\n')
  await ctx.reply(msg, { parse_mode: 'HTML' })
})

bot.command('ping', async (ctx) => {
  await ctx.reply('🏓 <b>Pong</b>', { parse_mode: 'HTML' })
})

bot.command('todo', async (ctx) => {
  if (!ctx.from || !isAllowed(ctx.from.id)) return
  const text = ctx.match?.trim()
  if (!text) {
    await ctx.reply('📝 Usage: /todo &lt;task description&gt;', { parse_mode: 'HTML' })
    return
  }
  const todo = addTodo(DATA_DIR, { title: text, source: 'user', priority: 'medium' })
  const msg = `📝 <b>Added</b>\n${todo.title} <code>${todo.id.slice(0, 8)}</code>`
  await ctx.reply(msg, { parse_mode: 'HTML' })
})

bot.command('todos', async (ctx) => {
  if (!ctx.from || !isAllowed(ctx.from.id)) return
  const todos = loadTodos(DATA_DIR)
  const active = todos.filter(t => t.status === 'pending' || t.status === 'in_progress')
  if (active.length === 0) {
    await ctx.reply('📋 <b>Todos</b>\n\nNo active tasks.', { parse_mode: 'HTML' })
    return
  }
  const lines = active.map(t => {
    const icon = t.status === 'in_progress' ? '🔄' : '⏳'
    return `${icon} ${t.title} <i>(${t.priority})</i>`
  })
  await ctx.reply(`📋 <b>Todos</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' })
})

bot.command('clear', async (ctx) => {
  if (!ctx.from || !isAllowed(ctx.from.id)) return
  const removed = clearDone(DATA_DIR)
  await ctx.reply(`🧹 <b>Clear</b>\n\nRemoved ${removed} completed/failed tasks.`, { parse_mode: 'HTML' })
})

bot.command('stop', async (ctx) => {
  if (!ctx.from || !isAllowed(ctx.from.id)) return
  if (!activeChild) {
    await ctx.reply('🛑 <b>Stop</b>\n\nNo active task.', { parse_mode: 'HTML' })
    return
  }
  activeChild.kill('SIGTERM')
  await ctx.reply('🛑 <b>Stop</b>\n\nTask terminated.', { parse_mode: 'HTML' })
})

bot.command(['exit', 'shutdown', 'quit'], async (ctx) => {
  if (!ctx.from || !isAllowed(ctx.from.id)) return
  const msg = [
    '⚠️ <b>Exit</b>',
    '',
    'This will shut down the daemon.',
    'You will not be able to restart it from Telegram.',
    '',
    'Are you sure?',
  ].join('\n')
  await ctx.reply(msg, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: 'Yes, shut down', callback_data: 'exit_confirm' },
        { text: 'Cancel', callback_data: 'exit_cancel' },
      ]],
    },
  })
})

bot.callbackQuery('exit_confirm', async (ctx) => {
  await ctx.answerCallbackQuery()
  await ctx.editMessageText('🔴 <b>Heartbeat Stopped</b>', { parse_mode: 'HTML' })
  bot.stop()
  process.exit(0)
})

bot.callbackQuery('exit_cancel', async (ctx) => {
  await ctx.answerCallbackQuery()
  await ctx.editMessageText('⚠️ <b>Exit</b>\n\nCancelled.', { parse_mode: 'HTML' })
})

bot.on('message:text', async (ctx) => {
  if (!ctx.from || !isAllowed(ctx.from.id)) return

  messageBuffer = [...messageBuffer, {
    from: ctx.from.first_name ?? 'User',
    text: ctx.message.text,
    chat_id: ctx.chat.id,
    message_id: ctx.message.message_id,
  }]

  if (!isProcessing) {
    await spawnCli('user', ctx.chat.id)
  }
})

// === Telegram Streaming ===

const TELEGRAM_MAX_LENGTH = 4096

async function sendDraft(chatId: number, draftId: string, text: string): Promise<void> {
  const truncated = text.length > TELEGRAM_MAX_LENGTH
    ? text.slice(0, TELEGRAM_MAX_LENGTH - 4) + ' ...'
    : text
  try {
    // Try Bot API 9.5 sendMessageDraft
    await (bot.api as any).raw.sendMessageDraft({
      chat_id: chatId,
      draft_id: draftId,
      text: truncated,
    })
  } catch {
    // Silently ignore draft failures — final sendMessage will work
  }
}

async function sendFinalMessage(chatId: number, text: string): Promise<void> {
  const redacted = redactSecrets(text)
  if (redacted.length <= TELEGRAM_MAX_LENGTH) {
    await bot.api.sendMessage(chatId, redacted)
    return
  }
  // Chunk split for long messages
  const chunks: string[] = []
  let remaining = redacted
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, TELEGRAM_MAX_LENGTH))
    remaining = remaining.slice(TELEGRAM_MAX_LENGTH)
  }
  for (const chunk of chunks) {
    await bot.api.sendMessage(chatId, chunk)
  }
}

// === Telegram Feedback Helpers ===

function setReaction(chatId: number, messageId: number, emoji: string): void {
  bot.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji } as any])
    .catch(() => {})
}


// === MCP SSE Server ===

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'heartbeat', version: '0.1.0' })

  server.tool('telegram_read', 'Read new Telegram messages', {}, async () => {
    const messages = messageBuffer
    saveJson('pending_messages.json', messages)
    messageBuffer = []
    return { content: [{ type: 'text', text: JSON.stringify(messages) }] }
  })

  server.tool(
    'telegram_send',
    'Send a message to Telegram',
    { text: z.string(), chat_id: z.number().optional() },
    async ({ text, chat_id }) => {
      const targetChat = chat_id ?? config.telegram.default_chat_id
      await sendFinalMessage(targetChat, text)
      return { content: [{ type: 'text', text: 'Sent.' }] }
    }
  )

  server.tool(
    'todo_list',
    'List todo items, optionally filtered by status',
    { status: z.string().optional() },
    async ({ status }) => {
      const todos = loadTodos(DATA_DIR)
      const filtered = status ? todos.filter(t => t.status === status) : todos
      return { content: [{ type: 'text', text: JSON.stringify(filtered) }] }
    }
  )

  server.tool(
    'todo_add',
    'Add a new todo item',
    { title: z.string(), description: z.string().optional(), priority: z.enum(['high', 'medium', 'low']).optional() },
    async ({ title, description, priority }) => {
      const todo = addTodo(DATA_DIR, { title, description, priority, source: 'agent' })
      return { content: [{ type: 'text', text: JSON.stringify(todo) }] }
    }
  )

  server.tool(
    'todo_update',
    'Update a todo item status',
    { id: z.string(), status: z.enum(['pending', 'in_progress', 'done', 'failed']), result: z.string().optional() },
    async ({ id, status, result }) => {
      const todo = updateTodo(DATA_DIR, id, { status, result })
      return { content: [{ type: 'text', text: JSON.stringify(todo) }] }
    }
  )

  server.tool('heartbeat_check', 'Run health checks and return results', {}, async () => {
    const results: { command: string; output: string }[] = []
    for (const cmd of config.heartbeat.checks) {
      try {
        const output = await execShell(cmd, config.agent.cwd)
        if (output.trim()) {
          results.push({ command: cmd, output: output.trim() })
        }
      } catch (err) {
        results.push({ command: cmd, output: `Error: ${(err as Error).message}` })
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(results) }] }
  })

  return server
}

function execShell(cmd: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, timeout: config.heartbeat.check_timeout }, (err, stdout, stderr) => {
      if (err) return reject(err)
      resolve(stdout + stderr)
    })
  })
}

// SSE transport with bearer token auth
function startMcpServer(): void {
  const sessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>()

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Bearer token auth
    const auth = req.headers.authorization
    if (auth !== `Bearer ${config.mcp.token}`) {
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }

    const url = new URL(req.url ?? '/', `http://localhost:${config.mcp.port}`)

    if (url.pathname === '/sse') {
      const server = createMcpServer()
      const transport = new SSEServerTransport('/messages', res)
      sessions.set(transport.sessionId, { transport, server })
      res.on('close', () => {
        sessions.delete(transport.sessionId)
        server.close().catch(() => {})
      })
      await server.connect(transport)
      return
    }

    if (url.pathname === '/messages' && req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId')
      const session = sessionId ? sessions.get(sessionId) : undefined
      if (!session) {
        res.writeHead(404)
        res.end('Session not found')
        return
      }
      await session.transport.handlePostMessage(req, res)
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  httpServer.listen(config.mcp.port, '127.0.0.1', () => {
    console.log(`[mcp] SSE server listening on 127.0.0.1:${config.mcp.port}`)
  })
}

// === CLI Process Runner ===

interface CliCallbacks {
  onStdout(str: string): void
}

function runCliProcess(
  sandboxed: { command: string; args: string[]; cleanup?: () => void },
  cwd: string,
  timeout: number,
  callbacks: CliCallbacks
): Promise<number> {
  return new Promise((resolve) => {
    const cleanEnv = { ...process.env }
    delete cleanEnv.CLAUDECODE

    const child: ChildProcess = spawn(
      sandboxed.command,
      sandboxed.args,
      { cwd, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    activeChild = child
    child.on('exit', () => { activeChild = null })

    // Line buffer: accumulate partial lines across chunks so JSON parsing
    // always sees complete newline-terminated lines (prevents session_id loss)
    let lineBuffer = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      const data = lineBuffer + chunk.toString()
      const lines = data.split('\n')
      lineBuffer = lines.pop() ?? ''
      if (lines.length > 0) {
        callbacks.onStdout(lines.join('\n') + '\n')
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      console.error(`[cli] stderr: ${chunk.toString().slice(0, 500)}`)
    })

    child.on('error', (err) => {
      console.error(`[cli] spawn error:`, err.message)
      resolve(1)
    })

    // Use 'close' (not 'exit') to ensure all stdio is consumed before resolving
    child.on('close', (code) => {
      if (lineBuffer) {
        callbacks.onStdout(lineBuffer)
        lineBuffer = ''
      }
      clearTimeout(timer)
      resolve(code ?? 0)
    })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, config.agent.kill_grace)
    }, timeout)
  })
}

// === CLI Spawner + Streamer ===

async function spawnCli(type: 'user' | 'heartbeat', chatId?: number): Promise<void> {
  if (isProcessing) return
  isProcessing = true

  const targetChat = chatId ?? config.telegram.default_chat_id
  const session = sessions[type]

  // Reset session if max turns exceeded
  const currentSession = session.turns >= config.agent.session_max_turns
    ? { id: null, turns: 0 }
    : session

  const triggerMessageId: number | null = type === 'user' && messageBuffer.length > 0
    ? messageBuffer[messageBuffer.length - 1]!.message_id
    : null

  // Build prompt with cross-context
  let prompt: string
  if (type === 'user') {
    const messages = messageBuffer.map(m => `[${m.from}]: ${m.text}`).join('\n')
    messageBuffer = []
    prompt = `New messages:\n${messages}`
    if (context.lastHeartbeat) {
      const truncated = context.lastHeartbeat.slice(0, config.agent.cross_context_max_chars)
      prompt += `\n\n---\n[Heartbeat context (read-only):\n${truncated}]`
    }
  } else {
    prompt = config.heartbeat.prompt
    if (context.lastUser) {
      const truncated = context.lastUser.slice(0, config.agent.cross_context_max_chars)
      prompt += `\n\n---\n[User context (read-only):\n${truncated}]`
    }
  }

  const args = cliBuilder.buildArgs(currentSession.id, prompt)

  // Sandbox wrapper
  const sandboxed = wrapWithSandbox(
    cliBuilder.command,
    args,
    config.sandbox,
    config.agent.cwd,
    config.agent.cli
  )

  const draftId = `draft_${type}_${Date.now()}`
  let accumulated = ''
  let capturedSessionId: string | null = null
  let lastDraftTime = 0
  const throttle = config.streaming.throttle

  let extractActivity = createActivityExtractor(config.agent.cli)

  if (triggerMessageId !== null) {
    setReaction(targetChat, triggerMessageId, '🤔')
  }

  const handleStdout = (str: string): void => {
    if (!capturedSessionId) {
      capturedSessionId = cliBuilder.parseSessionId(str)
    }
    const text = cliBuilder.extractText(str)
    if (text) {
      accumulated += text
      const now = Date.now()
      if (now - lastDraftTime >= throttle) {
        lastDraftTime = now
        sendDraft(targetChat, draftId, accumulated).catch(() => {})
      }
    }

    const activity = extractActivity(str)
    if (activity) {
      if (activity.emoji && triggerMessageId !== null) {
        setReaction(targetChat, triggerMessageId, activity.emoji)
      }
    }
  }

  try {
    const exitCode = await runCliProcess(sandboxed, config.agent.cwd, config.agent.timeout, {
      onStdout: handleStdout,
    })

    // Resume failed → retry once as fresh session
    let didRetryFresh = false
    if (exitCode !== 0 && currentSession.id) {
      didRetryFresh = true
      console.error(`[cli] Resume failed (exit ${exitCode}), retrying as fresh session`)
      accumulated = ''
      capturedSessionId = null
      extractActivity = createActivityExtractor(config.agent.cli)
      const freshArgs = cliBuilder.buildArgs(null, prompt)
      const freshSandboxed = wrapWithSandbox(
        cliBuilder.command, freshArgs, config.sandbox, config.agent.cwd, config.agent.cli
      )
      await runCliProcess(freshSandboxed, config.agent.cwd, config.agent.timeout, {
        onStdout: handleStdout,
      })
      freshSandboxed.cleanup?.()
    }

    // Update session — preserve existing ID if capture failed during successful resume
    const effectiveSessionId = capturedSessionId
      ?? (didRetryFresh ? null : currentSession.id)
    const sessionChanged = effectiveSessionId !== currentSession.id
    const updatedSession = {
      id: effectiveSessionId,
      turns: sessionChanged ? 1 : currentSession.turns + 1,
    }
    sessions = { ...sessions, [type]: updatedSession }
    saveJson('sessions.json', sessions)
    console.log(`[cli] ${type} session: ${currentSession.id?.slice(0, 8) ?? 'new'} → ${effectiveSessionId?.slice(0, 8) ?? 'null'} (turn ${updatedSession.turns}${sessionChanged ? ', reset' : ''})`)

    // HEARTBEAT_OK suppression
    const finalText = accumulated.trim()
    if (type === 'heartbeat' && finalText.includes('HEARTBEAT_OK')) {
      // Suppress — nothing to report
    } else if (finalText) {
      await sendFinalMessage(targetChat, finalText)
    }

    // Completion reaction
    if (triggerMessageId !== null) {
      setReaction(targetChat, triggerMessageId, '👍')
    }

    // Save cross-context immutably
    const summary = finalText.slice(0, config.agent.cross_context_max_chars)
    context = type === 'user'
      ? { ...context, lastUser: summary }
      : { ...context, lastHeartbeat: summary }
    saveJson('context.json', context)

  } catch (err) {
    console.error(`[cli] ${type} spawn error:`, err)
    await bot.api.sendMessage(targetChat, `Error: ${(err as Error).message}`).catch(() => {})
  } finally {
    sandboxed.cleanup?.()
    isProcessing = false

    // Process buffered messages
    if (messageBuffer.length > 0) {
      const nextChat = messageBuffer[0]!.chat_id
      await spawnCli('user', nextChat)
    }
  }
}

// === Heartbeat ===

function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)(s|m|h)$/)
  if (!match) throw new Error(`Invalid interval format: "${interval}" (expected <number>s|m|h)`)
  const [, num, unit] = match
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000 }[unit!]!
  return parseInt(num!, 10) * multiplier
}


function startHeartbeat(): void {
  const intervalMs = parseInterval(config.heartbeat.interval)
  console.log(`[heartbeat] interval: ${config.heartbeat.interval} (${intervalMs}ms)`)

  const tick = async () => {
    if (!isProcessing) {
      recoverStuck(DATA_DIR, config.agent.timeout)
      await spawnCli('heartbeat')
    }

    setTimeout(tick, intervalMs)
  }

  setTimeout(tick, intervalMs)
}

// === Main ===

function killExistingDaemon(): void {
  try {
    const pids = execSync(`lsof -ti :${config.mcp.port}`, { encoding: 'utf-8' }).trim()
    if (!pids) return
    for (const pid of pids.split('\n')) {
      if (pid && pid !== String(process.pid)) {
        process.kill(parseInt(pid, 10), 'SIGTERM')
      }
    }
    // Brief wait for graceful shutdown
    execSync('sleep 1')
    console.log(`[heartbeat] Killed existing daemon on port ${config.mcp.port}`)
  } catch {
    // No process on port — nothing to kill
  }
}

async function main(): Promise<void> {
  killExistingDaemon()
  console.log(`[heartbeat] Starting daemon (cli: ${config.agent.cli}, cwd: ${config.agent.cwd})`)

  // Ensure data directory (mkdirSync recursive is idempotent)
  mkdirSync(DATA_DIR, { recursive: true })

  // Config file permissions
  chmodSync(CONFIG_PATH, 0o600)

  // Catch-all error handlers for diagnostics
  process.on('uncaughtException', (err) => {
    console.error('[heartbeat] Uncaught exception:', err)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[heartbeat] Unhandled rejection:', reason)
  })
  process.on('exit', (code) => {
    console.error(`[heartbeat] Process exiting with code ${code}`)
  })

  bot.catch((err) => {
    console.error('[telegram] Bot error:', err)
  })

  bot.start({ onStart: () => console.log('[telegram] Bot started (long-polling)') })
  startMcpServer()
  startHeartbeat()

  const targetChat = config.telegram.default_chat_id
  const shortCwd = config.agent.cwd.replace(homedir(), '~')
  const startMsg = [
    '🟢 <b>Heartbeat Started</b>',
    '',
    `<pre>@beatclaw/heartbeat v0.1.0`,
    `cli  ${config.agent.cli}`,
    `cwd  ${shortCwd}`,
    `beat ${config.heartbeat.interval}`,
    `mcp  :${config.mcp.port}</pre>`,
  ].join('\n')
  bot.api.sendMessage(targetChat, startMsg, { parse_mode: 'HTML' }).catch(() => {})

  // Graceful shutdown
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      console.log(`[heartbeat] Received ${signal}, shutting down...`)
      await bot.api.sendMessage(targetChat, '🔴 <b>Heartbeat Stopped</b>', { parse_mode: 'HTML' }).catch(() => {})
      bot.stop()
      process.exit(0)
    })
  }
}

main().catch((err) => {
  console.error('[heartbeat] Fatal error:', err)
  process.exit(1)
})
