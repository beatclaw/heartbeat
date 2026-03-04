#!/usr/bin/env node
// src/stop.ts — Stop all running heartbeat daemon processes

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { parse as parseYaml } from 'yaml'

const CONFIG_PATH = join(process.cwd(), 'config.yaml')

function loadPort(): number {
  if (!existsSync(CONFIG_PATH)) return 39100
  try {
    const raw = parseYaml(readFileSync(CONFIG_PATH, 'utf-8')) as { mcp?: { port?: number } }
    return raw.mcp?.port ?? 39100
  } catch {
    return 39100
  }
}

function killPid(pid: number): void {
  try { process.kill(pid, 'SIGTERM') } catch { /* already dead */ }
  // Wait briefly, then SIGKILL if still alive
  try {
    execSync(`sleep 1`)
    process.kill(pid, 0) // check alive
    process.kill(pid, 'SIGKILL')
  } catch { /* dead */ }
}

function killByPort(port: number): number {
  try {
    const pids = execSync(`lsof -ti :${port}`, { encoding: 'utf-8' }).trim()
    if (!pids) return 0
    for (const pid of pids.split('\n')) {
      killPid(parseInt(pid, 10))
    }
    return pids.split('\n').length
  } catch {
    return 0
  }
}

function killByPattern(): number {
  try {
    execSync('pkill "node dist/index.js"', { encoding: 'utf-8' })
    execSync('sleep 1')
    execSync('pkill -9 "node dist/index.js"', { encoding: 'utf-8' })
    return 1
  } catch {
    return 0
  }
}

const port = loadPort()
const byPort = killByPort(port)
const byPattern = killByPattern()

if (byPort > 0 || byPattern > 0) {
  console.log(`Stopped heartbeat daemon (port: ${port})`)
} else {
  console.log('No running heartbeat daemon found.')
}
