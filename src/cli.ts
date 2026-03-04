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
      return ['exec', 'resume', sessionId, prompt, '--full-auto', '--json']
    }
    return ['exec', prompt, '--full-auto', '--json']
  }

  parseSessionId(output: string): string | null {
    for (const line of output.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        // Codex uses thread_id or session_id
        const id = parsed.thread_id ?? parsed.session_id ?? parsed.id
        if (typeof id === 'string' && id.length > 0) return id
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
        if (parsed.type === 'message' && parsed.content) {
          parts.push(String(parsed.content))
        }
        if (parsed.text) {
          parts.push(String(parsed.text))
        }
      } catch {
        // plain text fallback
        parts.push(line)
      }
    }
    return parts.join('')
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
