// src/cli.ts — Per-CLI command builders

export interface CliBuilder {
  readonly command: string
  readonly systemPromptFile: string
  buildArgs(sessionId: string | null, prompt: string): string[]
  parseSessionId(output: string): string | null
  extractText(chunk: string): string
}

// === Claude Code ===

export class ClaudeCodeBuilder implements CliBuilder {
  readonly command = 'claude'
  readonly systemPromptFile = 'CLAUDE.md'

  buildArgs(sessionId: string | null, prompt: string): string[] {
    const args = sessionId
      ? ['--resume', sessionId, '-p', prompt]
      : ['-p', prompt]
    return [...args, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose']
  }

  parseSessionId(output: string): string | null {
    // stream-json emits {"type":"system","session_id":"..."} early in the stream
    for (const line of output.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed.session_id) return parsed.session_id as string
      } catch {
        // not JSON, skip
      }
    }
    return null
  }

  extractText(chunk: string): string {
    const parts: string[] = []
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        // assistant message content
        if (parsed.type === 'assistant' && parsed.message?.content) {
          for (const block of parsed.message.content) {
            if (block.type === 'text' && block.text) {
              parts.push(block.text)
            }
          }
        }
        // content_block_delta (streaming text delta)
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          parts.push(parsed.delta.text)
        }
      } catch {
        // not JSON, skip
      }
    }
    return parts.join('')
  }
}

// === Codex CLI ===

export class CodexBuilder implements CliBuilder {
  readonly command = 'codex'
  readonly systemPromptFile = 'AGENTS.md'

  buildArgs(sessionId: string | null, prompt: string): string[] {
    if (sessionId) {
      return ['exec', 'resume', sessionId, prompt, '--full-auto', '--skip-git-repo-check', '--json']
    }
    return ['exec', prompt, '--full-auto', '--skip-git-repo-check', '--json']
  }

  parseSessionId(output: string): string | null {
    for (const line of output.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        // Codex emits {"type":"thread.started","thread_id":"..."} as the first event
        if (parsed.type === 'thread.started' && typeof parsed.thread_id === 'string') {
          return parsed.thread_id
        }
      } catch {
        // not JSON, skip
      }
    }
    return null
  }

  extractText(chunk: string): string {
    const parts: string[] = []
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        // item.completed with agent_message contains the response text
        if (parsed.type === 'item.completed' && parsed.item?.type === 'agent_message' && parsed.item.text) {
          parts.push(String(parsed.item.text))
        }
      } catch {
        // not JSON — skip (all codex output in --json mode is JSONL)
      }
    }
    return parts.join('')
  }
}

// === Activity Extraction ===

export interface AgentActivity {
  readonly emoji: string | null
  readonly label: string | null
}

function basename(filePath: string): string {
  const parts = filePath.split('/')
  return parts[parts.length - 1] ?? filePath
}

function tryHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url.slice(0, 30)
  }
}

function tryParseJson(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str) as Record<string, unknown>
  } catch {
    return {}
  }
}

function short(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str
}

function toolReactionEmoji(name: string): string {
  switch (name) {
    case 'Read':
    case 'Grep':
    case 'Glob':
      return '👀'
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return '✍'
    case 'Bash':
      return '👨‍💻'
    case 'WebFetch':
    case 'WebSearch':
      return '⚡'
    case 'Agent':
      return '🤓'
    default:
      return '⚡'
  }
}

function formatToolActivity(name: string, input: Record<string, unknown>): AgentActivity {
  let label: string
  switch (name) {
    case 'Read':
      label = `📖 Read: ${basename(String(input.file_path ?? ''))}`
      break
    case 'Grep':
      label = `🔍 Grep: "${short(String(input.pattern ?? ''), 40)}"`
      break
    case 'Glob':
      label = `🔍 Glob: ${short(String(input.pattern ?? ''), 40)}`
      break
    case 'Write':
      label = `✍️ Write: ${basename(String(input.file_path ?? ''))}`
      break
    case 'Edit':
    case 'MultiEdit':
      label = `✍️ Edit: ${basename(String(input.file_path ?? ''))}`
      break
    case 'Bash':
      label = `💻 Bash: ${short(String(input.command ?? ''), 50)}`
      break
    case 'WebFetch':
      label = `🌐 Fetch: ${tryHostname(String(input.url ?? ''))}`
      break
    case 'WebSearch':
      label = `🌐 Search: ${short(String(input.query ?? ''), 40)}`
      break
    case 'Agent':
      label = `🤖 Agent: ${short(String(input.description ?? ''), 40)}`
      break
    default:
      label = `⚙️ ${name}`
  }
  return { emoji: null, label }
}

function createCodexActivityExtractor(): (chunk: string) => AgentActivity | null {
  return (chunk: string): AgentActivity | null => {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed.type === 'turn.started') {
          return { emoji: '🤔', label: '🤔 Thinking...' }
        }
        if (parsed.type === 'item.completed' && parsed.item?.type === 'tool_use') {
          return { emoji: '⚡', label: `⚙️ ${short(String(parsed.item.name ?? 'tool'), 40)}` }
        }
      } catch {
        // not JSON, skip
      }
    }
    return null
  }
}

export function createActivityExtractor(cliType: string): (chunk: string) => AgentActivity | null {
  if (cliType === 'codex') return createCodexActivityExtractor()
  if (cliType !== 'claude') return () => null

  const blockState = new Map<number, { name: string; inputJson: string }>()

  return (chunk: string): AgentActivity | null => {
    let emoji: string | null = null
    let label: string | null = null

    for (const line of chunk.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)

        if (parsed.type === 'content_block_start' && parsed.content_block) {
          const block = parsed.content_block
          const index = parsed.index as number

          if (block.type === 'thinking') {
            emoji = '🤔'
            label = '🤔 Thinking...'
          }

          if (block.type === 'tool_use' && block.name) {
            blockState.set(index, { name: block.name, inputJson: '' })
            emoji = toolReactionEmoji(block.name)
          }
        }

        if (parsed.type === 'content_block_delta' && parsed.delta) {
          if (parsed.delta.type === 'input_json_delta' && parsed.delta.partial_json) {
            const state = blockState.get(parsed.index as number)
            if (state) {
              blockState.set(parsed.index as number, {
                ...state,
                inputJson: state.inputJson + parsed.delta.partial_json,
              })
            }
          }
        }

        if (parsed.type === 'content_block_stop') {
          const state = blockState.get(parsed.index as number)
          if (state) {
            blockState.delete(parsed.index as number)
            const input = tryParseJson(state.inputJson)
            const activity = formatToolActivity(state.name, input)
            label = activity.label
          }
        }
      } catch {
        // not JSON, skip
      }
    }

    if (emoji === null && label === null) return null
    return { emoji, label }
  }
}

// === Factory ===

export function getCliBuilder(cli: string): CliBuilder {
  switch (cli) {
    case 'claude': return new ClaudeCodeBuilder()
    case 'codex': return new CodexBuilder()
    default: throw new Error(`Unsupported CLI: ${cli}. Use "claude" or "codex".`)
  }
}
