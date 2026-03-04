#!/usr/bin/env node
// src/status.ts — Show running heartbeat daemon status

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { parse as parseYaml } from 'yaml'

const CONFIG_PATH = join(process.cwd(), 'config.yaml')

interface PartialConfig {
  mcp: { port: number }
  agent: { cli: string; cwd: string }
  heartbeat: { interval: string }
}

function loadPort(): number {
  if (!existsSync(CONFIG_PATH)) return 39100
  try {
    const raw = parseYaml(readFileSync(CONFIG_PATH, 'utf-8')) as PartialConfig
    return raw.mcp?.port ?? 39100
  } catch {
    return 39100
  }
}

function getProcessInfo(port: number): { pid: string; command: string } | null {
  try {
    const output = execSync(`lsof -ti :${port}`, { encoding: 'utf-8' }).trim()
    if (!output) return null
    const pid = output.split('\n')[0]!
    const command = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf-8' }).trim()
    return { pid, command }
  } catch {
    return null
  }
}

function getTodoStats(): { pending: number; inProgress: number; done: number; failed: number } {
  const todosPath = join(process.cwd(), 'data', 'todos.json')
  if (!existsSync(todosPath)) return { pending: 0, inProgress: 0, done: 0, failed: 0 }
  try {
    const todos = JSON.parse(readFileSync(todosPath, 'utf-8')) as { status: string }[]
    return {
      pending: todos.filter(t => t.status === 'pending').length,
      inProgress: todos.filter(t => t.status === 'in_progress').length,
      done: todos.filter(t => t.status === 'done').length,
      failed: todos.filter(t => t.status === 'failed').length,
    }
  } catch {
    return { pending: 0, inProgress: 0, done: 0, failed: 0 }
  }
}

function main(): void {
  const port = loadPort()
  const proc = getProcessInfo(port)

  console.log('=== Heartbeat Status ===\n')

  if (proc) {
    console.log(`Status:  RUNNING`)
    console.log(`PID:     ${proc.pid}`)
    console.log(`Port:    ${port}`)
    console.log(`Command: ${proc.command}`)
  } else {
    console.log(`Status:  STOPPED`)
    console.log(`Port:    ${port} (not in use)`)
  }

  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = parseYaml(readFileSync(CONFIG_PATH, 'utf-8')) as PartialConfig
      console.log(`\nCLI:       ${raw.agent?.cli ?? 'unknown'}`)
      console.log(`CWD:       ${raw.agent?.cwd ?? 'unknown'}`)
      console.log(`Interval:  ${raw.heartbeat?.interval ?? 'unknown'}`)
    } catch { /* ignore */ }
  } else {
    console.log('\nconfig.yaml not found')
  }

  const stats = getTodoStats()
  const total = stats.pending + stats.inProgress + stats.done + stats.failed
  if (total > 0) {
    console.log(`\nTodos:     ${stats.pending} pending, ${stats.inProgress} in_progress, ${stats.done} done, ${stats.failed} failed`)
  } else {
    console.log(`\nTodos:     (empty)`)
  }
}

main()
