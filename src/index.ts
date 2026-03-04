#!/usr/bin/env node
// src/index.ts — Daemon: telegram + MCP SSE + heartbeat + spawner + streaming

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn, exec, type ChildProcess } from 'node:child_process'
import { Bot } from 'grammy'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { getCliBuilder, type CliBuilder } from './cli.js'
import { wrapWithSandbox, type SandboxConfig } from './sandbox.js'
import { loadTodos, addTodo, updateTodo, getNextTodo, clearDone, recoverStuck } from './todos.js'

// === Config ===

interface TelegramMessage {
  from: string
  text: string
  chat_id: number
}

interface Config {
  agent: { cli: string; cwd: string; timeout: number; session_max_turns: number }
  telegram: { token: string; default_chat_id: number; allowed_users: number[] }
  heartbeat: { interval: string; active_hours: string; checks: string[]; prompt: string }
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
const CROSS_CONTEXT_MAX_CHARS = 500

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

bot.command('chatid', async (ctx) => {
  await ctx.reply(`Chat ID: ${ctx.chat.id}\nUser ID: ${ctx.from?.id}`)
})

bot.command('ping', async (ctx) => {
  await ctx.reply('pong')
})

bot.command('todo', async (ctx) => {
  if (!ctx.from || !isAllowed(ctx.from.id)) return
  const text = ctx.match?.trim()
  if (!text) {
    await ctx.reply('Usage: /todo <task description>')
    return
  }
  const todo = addTodo(DATA_DIR, { title: text, source: 'user', priority: 'medium' })
  await ctx.reply(`Added: ${todo.title} (${todo.id.slice(0, 8)})`)
})

bot.command('todos', async (ctx) => {
  if (!ctx.from || !isAllowed(ctx.from.id)) return
  const todos = loadTodos(DATA_DIR)
  const active = todos.filter(t => t.status === 'pending' || t.status === 'in_progress')
  if (active.length === 0) {
    await ctx.reply('No pending tasks.')
    return
  }
  const lines = active.map(t => {
    const icon = t.status === 'in_progress' ? '🔄' : '⏳'
    return `${icon} ${t.title} (${t.priority})`
  })
  await ctx.reply(lines.join('\n'))
})

bot.command('clear', async (ctx) => {
  if (!ctx.from || !isAllowed(ctx.from.id)) return
  const removed = clearDone(DATA_DIR)
  await ctx.reply(`Cleared ${removed} completed/failed tasks.`)
})

bot.on('message:text', async (ctx) => {
  if (!ctx.from || !isAllowed(ctx.from.id)) return

  messageBuffer = [...messageBuffer, {
    from: ctx.from.first_name ?? 'User',
    text: ctx.message.text,
    chat_id: ctx.chat.id,
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
    exec(cmd, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
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

    child.stdout?.on('data', (chunk: Buffer) => {
      callbacks.onStdout(chunk.toString())
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      console.error(`[cli] stderr: ${chunk.toString().slice(0, 500)}`)
    })

    child.on('error', (err) => {
      console.error(`[cli] spawn error:`, err.message)
      resolve(1)
    })

    child.on('exit', (code) => resolve(code ?? 0))

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 5000)
    }, timeout)

    child.on('exit', () => clearTimeout(timer))
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

  // Build prompt with cross-context
  let prompt: string
  if (type === 'user') {
    const messages = messageBuffer.map(m => `[${m.from}]: ${m.text}`).join('\n')
    messageBuffer = []
    prompt = `New messages:\n${messages}`
    if (context.lastHeartbeat) {
      const truncated = context.lastHeartbeat.slice(0, CROSS_CONTEXT_MAX_CHARS)
      prompt += `\n\n---\n[Heartbeat context (read-only):\n${truncated}]`
    }
  } else {
    prompt = config.heartbeat.prompt
    if (context.lastUser) {
      const truncated = context.lastUser.slice(0, CROSS_CONTEXT_MAX_CHARS)
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

  try {
    const exitCode = await runCliProcess(sandboxed, config.agent.cwd, config.agent.timeout, {
      onStdout(str) {
        if (!capturedSessionId) {
          capturedSessionId = cliBuilder.parseSessionId(str)
        }
        const text = cliBuilder.extractText(str)
        if (!text) return
        accumulated += text
        const now = Date.now()
        if (now - lastDraftTime >= throttle) {
          lastDraftTime = now
          sendDraft(targetChat, draftId, accumulated).catch(() => {})
        }
      },
    })

    // Continue failed → retry once as fresh session
    if (exitCode !== 0 && currentSession.id) {
      console.error(`[cli] Continue failed (exit ${exitCode}), retrying as fresh session`)
      accumulated = ''
      capturedSessionId = null
      const freshArgs = cliBuilder.buildArgs(null, prompt)
      const freshSandboxed = wrapWithSandbox(
        cliBuilder.command, freshArgs, config.sandbox, config.agent.cwd, config.agent.cli
      )
      await runCliProcess(freshSandboxed, config.agent.cwd, config.agent.timeout, {
        onStdout(str) {
          if (!capturedSessionId) {
            capturedSessionId = cliBuilder.parseSessionId(str)
          }
          const text = cliBuilder.extractText(str)
          if (!text) return
          accumulated += text
          const now = Date.now()
          if (now - lastDraftTime >= throttle) {
            lastDraftTime = now
            sendDraft(targetChat, draftId, accumulated).catch(() => {})
          }
        },
      })
      freshSandboxed.cleanup?.()
    }

    // Update session — track whether we have an active session for --continue
    const updatedSession = {
      id: capturedSessionId ?? null,
      turns: currentSession.turns + 1,
    }
    sessions = { ...sessions, [type]: updatedSession }
    saveJson('sessions.json', sessions)

    // HEARTBEAT_OK suppression
    const finalText = accumulated.trim()
    if (type === 'heartbeat' && finalText === 'HEARTBEAT_OK') {
      // Suppress — nothing to report
    } else if (finalText) {
      await sendFinalMessage(targetChat, finalText)
    }

    // Save cross-context immutably
    const summary = finalText.slice(0, CROSS_CONTEXT_MAX_CHARS)
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
  if (!match) return 30 * 60 * 1000 // default 30m
  const [, num, unit] = match
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000 }[unit!]!
  return parseInt(num!, 10) * multiplier
}

function isActiveHours(): boolean {
  const range = config.heartbeat.active_hours
  if (!range) return true
  const match = range.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/)
  if (!match) return true
  const now = new Date()
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const startMinutes = parseInt(match[1]!, 10) * 60 + parseInt(match[2]!, 10)
  const endMinutes = parseInt(match[3]!, 10) * 60 + parseInt(match[4]!, 10)
  return currentMinutes >= startMinutes && currentMinutes <= endMinutes
}

function startHeartbeat(): void {
  const intervalMs = parseInterval(config.heartbeat.interval)
  console.log(`[heartbeat] interval: ${config.heartbeat.interval} (${intervalMs}ms)`)

  setInterval(async () => {
    if (!isActiveHours()) return
    if (isProcessing) return

    // Recover stuck todos before checking
    recoverStuck(DATA_DIR, config.agent.timeout)

    // Cheap check: skip if no pending todos
    if (getNextTodo(DATA_DIR) === null) return

    await spawnCli('heartbeat')
  }, intervalMs)
}

// === Main ===

async function main(): Promise<void> {
  console.log(`[heartbeat] Starting daemon (cli: ${config.agent.cli}, cwd: ${config.agent.cwd})`)

  // Ensure data directory (mkdirSync recursive is idempotent)
  mkdirSync(DATA_DIR, { recursive: true })

  // Config file permissions
  chmodSync(CONFIG_PATH, 0o600)

  bot.start({ onStart: () => console.log('[telegram] Bot started (long-polling)') })
  startMcpServer()
  startHeartbeat()

  // Graceful shutdown
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`[heartbeat] Received ${signal}, shutting down...`)
      bot.stop()
      process.exit(0)
    })
  }
}

main().catch((err) => {
  console.error('[heartbeat] Fatal error:', err)
  process.exit(1)
})
