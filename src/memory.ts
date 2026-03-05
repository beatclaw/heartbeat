// src/memory.ts — Semantic memory: data model + CRUD + compact + passive attach

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// === Data Model ===

export interface Memory {
  readonly id: string
  readonly content: string
  readonly tags: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly accessCount: number
  readonly estimatedTokens: number
}

export interface MemoryConfig {
  readonly passive_attach_budget: number // max tokens for passive attach (default 2000)
}

const FILENAME = 'memories.json'

// === Token Estimation (multilingual safe) ===

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf-8') / 4)
}

// === File IO ===

function filePath(dataDir: string): string {
  return join(dataDir, FILENAME)
}

export function loadMemories(dataDir: string): readonly Memory[] {
  const p = filePath(dataDir)
  if (!existsSync(p)) return []
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Memory[]
  } catch {
    return []
  }
}

function saveMemories(dataDir: string, memories: readonly Memory[]): void {
  const p = filePath(dataDir)
  writeFileSync(p, JSON.stringify(memories, null, 2), 'utf-8')
  chmodSync(p, 0o600)
}

// === Similarity ===

function tokenize(text: string): ReadonlySet<string> {
  return new Set(
    text.toLowerCase().split(/[\s,.;:!?()[\]{}"'`\n\r\t]+/).filter(w => w.length > 1)
  )
}

function wordOverlap(a: string, b: string): number {
  const setA = tokenize(a)
  const setB = tokenize(b)
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const word of setA) {
    if (setB.has(word)) intersection++
  }
  return intersection / Math.min(setA.size, setB.size)
}

function tagOverlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a)
  let intersection = 0
  for (const tag of b) {
    if (setA.has(tag)) intersection++
  }
  return intersection / Math.min(a.length, b.length)
}

function similarity(a: Memory, b: Memory): number {
  const wordScore = wordOverlap(a.content, b.content)
  const tagScore = tagOverlap(a.tags, b.tags)
  // Weighted: 60% content, 40% tags
  return wordScore * 0.6 + tagScore * 0.4
}

const SIMILARITY_THRESHOLD = 0.6
const MAX_MERGED_CONTENT_CHARS = 12000

function mergeContent(a: string, b: string): string {
  const combined = `${a}\n\n---\n\n${b}`
  if (combined.length <= MAX_MERGED_CONTENT_CHARS) return combined
  const tail = combined.slice(-MAX_MERGED_CONTENT_CHARS)
  return `[TRIMMED_OLD_MEMORY]\n\n${tail}`
}

// === CRUD ===

export function saveMemory(
  dataDir: string,
  params: { content: string; tags?: readonly string[] }
): { memory: Memory; merged: boolean; mergedWith?: string } {
  const now = new Date().toISOString()
  const tags = params.tags ?? []
  const tokens = estimateTokens(params.content)

  const candidate: Memory = {
    id: randomUUID(),
    content: params.content,
    tags,
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    estimatedTokens: tokens,
  }

  const memories = loadMemories(dataDir)

  // Auto-compact: find most similar existing memory
  let bestMatch: { index: number; score: number } | null = null
  for (let i = 0; i < memories.length; i++) {
    const score = similarity(candidate, memories[i]!)
    if (score >= SIMILARITY_THRESHOLD && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { index: i, score }
    }
  }

  if (bestMatch) {
    // Merge: append new content to existing, union tags, delete original
    const existing = memories[bestMatch.index]!
    const mergedContent = mergeContent(existing.content, params.content)
    const mergedTags = [...new Set([...existing.tags, ...tags])]
    const merged: Memory = {
      ...existing,
      content: mergedContent,
      tags: mergedTags,
      updatedAt: now,
      accessCount: existing.accessCount,
      estimatedTokens: estimateTokens(mergedContent),
    }
    const updated = [
      ...memories.slice(0, bestMatch.index),
      merged,
      ...memories.slice(bestMatch.index + 1),
    ]
    saveMemories(dataDir, updated)
    return { memory: merged, merged: true, mergedWith: existing.id }
  }

  // No similar memory found — save as new
  saveMemories(dataDir, [...memories, candidate])
  return { memory: candidate, merged: false }
}

export function searchMemories(
  dataDir: string,
  query: string,
  tags?: readonly string[]
): readonly Memory[] {
  const memories = loadMemories(dataDir)
  const queryWords = tokenize(query)

  const scored = memories
    .map(m => {
      // Text relevance
      const contentWords = tokenize(m.content)
      let matches = 0
      for (const w of queryWords) {
        if (contentWords.has(w)) matches++
      }
      const textScore = queryWords.size > 0 ? matches / queryWords.size : 0

      // Tag filter
      if (tags && tags.length > 0) {
        const memTags = new Set(m.tags)
        const hasTag = tags.some(t => memTags.has(t))
        if (!hasTag) return null
      }

      return { memory: m, score: textScore }
    })
    .filter((x): x is { memory: Memory; score: number } => x !== null && x.score > 0)
    .sort((a, b) => b.score - a.score)

  // Increment access_count for returned results
  if (scored.length > 0) {
    const resultIds = new Set(scored.map(s => s.memory.id))
    const updated = memories.map(m =>
      resultIds.has(m.id)
        ? { ...m, accessCount: m.accessCount + 1 }
        : m
    )
    saveMemories(dataDir, updated)
  }

  return scored.map(s => s.memory)
}

export function listMemories(dataDir: string, limit?: number): readonly Memory[] {
  const memories = loadMemories(dataDir)
  const sorted = [...memories].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )
  return limit ? sorted.slice(0, limit) : sorted
}

export function deleteMemory(dataDir: string, id: string): boolean {
  const memories = loadMemories(dataDir)
  const filtered = memories.filter(m => m.id !== id)
  if (filtered.length === memories.length) return false
  saveMemories(dataDir, filtered)
  return true
}

// === Full Compact ===

export function compactMemories(dataDir: string): { merged: number; total: number } {
  const memories = [...loadMemories(dataDir)]
  const removed = new Set<number>()
  let mergeCount = 0

  for (let i = 0; i < memories.length; i++) {
    if (removed.has(i)) continue
    for (let j = i + 1; j < memories.length; j++) {
      if (removed.has(j)) continue
      const score = similarity(memories[i]!, memories[j]!)
      if (score >= SIMILARITY_THRESHOLD) {
        // Merge j into i
        const a = memories[i]!
        const b = memories[j]!
        const mergedContent = mergeContent(a.content, b.content)
        const mergedTags = [...new Set([...a.tags, ...b.tags])]
        memories[i] = {
          ...a,
          content: mergedContent,
          tags: mergedTags,
          updatedAt: new Date().toISOString(),
          accessCount: Math.max(a.accessCount, b.accessCount),
          estimatedTokens: estimateTokens(mergedContent),
        }
        removed.add(j)
        mergeCount++
      }
    }
  }

  const result = memories.filter((_, i) => !removed.has(i))
  saveMemories(dataDir, result)
  return { merged: mergeCount, total: result.length }
}

// === Passive Attach ===

export function getPassiveAttach(dataDir: string, budgetTokens: number): string {
  const memories = loadMemories(dataDir)
  if (memories.length === 0) return ''

  const halfBudget = Math.floor(budgetTokens / 2)

  // Pool A: recent (updatedAt DESC)
  const byRecent = [...memories].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )

  // Pool B: most accessed (accessCount DESC)
  const byAccess = [...memories].sort((a, b) =>
    b.accessCount - a.accessCount
  )

  const selected = new Map<string, Memory>()
  let usedTokens = 0

  // Fill from Pool A (recent)
  for (const m of byRecent) {
    if (usedTokens >= halfBudget) break
    if (!selected.has(m.id) && usedTokens + m.estimatedTokens <= budgetTokens) {
      selected.set(m.id, m)
      usedTokens += m.estimatedTokens
    }
  }

  // Fill from Pool B (most accessed)
  for (const m of byAccess) {
    if (usedTokens >= budgetTokens) break
    if (!selected.has(m.id) && usedTokens + m.estimatedTokens <= budgetTokens) {
      selected.set(m.id, m)
      usedTokens += m.estimatedTokens
    }
  }

  if (selected.size === 0) return ''

  const lines = [...selected.values()].map(m => {
    const tagStr = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : ''
    return `- ${m.content}${tagStr}`
  })

  return `[Memory (${selected.size} items, ~${usedTokens} tokens)]:\n${lines.join('\n')}`
}
