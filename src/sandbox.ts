// src/sandbox.ts — OS sandbox wrapper

import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:process'

export interface SandboxConfig {
  enabled: boolean
  allowed_paths: string[]
  extra_paths: string[]
}

interface SandboxResult {
  command: string
  args: string[]
  cleanup?: () => void
}

// Resolve ~ and ${agent.cwd} in paths
function resolvePath(p: string, cwd: string, home: string): string {
  return p
    .replace(/^\$\{agent\.cwd\}/, cwd)
    .replace(/^~/, home)
}

// === macOS: sandbox-exec ===

function buildMacOSSandbox(
  command: string,
  args: string[],
  allowedPaths: string[]
): SandboxResult {
  const allows = allowedPaths
    .map(p => `(allow file-write* (subpath "${p}"))`)
    .join('\n')

  const profile = `(version 1)
(allow default)
(deny file-write* (subpath "/"))
${allows}
(allow file-write* (subpath "/tmp"))
(allow file-write* (regex #"^/dev/"))`

  const profilePath = join(tmpdir(), `beatclaw-sandbox-${Date.now()}.sb`)
  writeFileSync(profilePath, profile, 'utf-8')

  return {
    command: 'sandbox-exec',
    args: ['-f', profilePath, command, ...args],
    cleanup: () => {
      try { unlinkSync(profilePath) } catch { /* ignore */ }
    },
  }
}

// === Linux: bubblewrap ===

function buildLinuxSandbox(
  command: string,
  args: string[],
  allowedPaths: string[]
): SandboxResult {
  const bwrapArgs = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--bind', '/tmp', '/tmp',
  ]

  for (const p of allowedPaths) {
    bwrapArgs.push('--bind', p, p)
  }

  bwrapArgs.push(command, ...args)

  return {
    command: 'bwrap',
    args: bwrapArgs,
  }
}

// === Public API ===

export function wrapWithSandbox(
  command: string,
  args: string[],
  config: SandboxConfig,
  cwd: string,
  cliName: string
): SandboxResult {
  if (!config.enabled) {
    return { command, args }
  }

  const home = process.env.HOME ?? '/tmp'
  const allPaths = [
    ...config.allowed_paths,
    ...config.extra_paths,
    // CLI home directories (session/auth)
    `~/.${cliName}`,
  ]

  const resolved = allPaths.map(p => resolvePath(p, cwd, home))

  const os = platform
  if (os === 'darwin') {
    return buildMacOSSandbox(command, args, resolved)
  }
  if (os === 'linux') {
    return buildLinuxSandbox(command, args, resolved)
  }

  // Unsupported OS — run without sandbox
  console.warn(`[sandbox] Unsupported platform: ${os}. Running without sandbox.`)
  return { command, args }
}
