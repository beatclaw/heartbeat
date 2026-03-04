// src/todos.ts — Todo queue: data model + CRUD + file IO

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface Todo {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly status: 'pending' | 'in_progress' | 'done' | 'failed'
  readonly priority: 'high' | 'medium' | 'low'
  readonly source: 'user' | 'agent'
  readonly createdAt: string
  readonly startedAt?: string
  readonly completedAt?: string
  readonly result?: string
}

const FILENAME = 'todos.json'

function filePath(dataDir: string): string {
  return join(dataDir, FILENAME)
}

export function loadTodos(dataDir: string): readonly Todo[] {
  const p = filePath(dataDir)
  if (!existsSync(p)) return []
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Todo[]
  } catch {
    return []
  }
}

function saveTodos(dataDir: string, todos: readonly Todo[]): void {
  const p = filePath(dataDir)
  writeFileSync(p, JSON.stringify(todos, null, 2), 'utf-8')
  chmodSync(p, 0o600)
}

export function addTodo(
  dataDir: string,
  params: { title: string; description?: string; priority?: Todo['priority']; source: Todo['source'] }
): Todo {
  const todo: Todo = {
    id: randomUUID(),
    title: params.title,
    description: params.description,
    status: 'pending',
    priority: params.priority ?? 'medium',
    source: params.source,
    createdAt: new Date().toISOString(),
  }
  const todos = loadTodos(dataDir)
  saveTodos(dataDir, [...todos, todo])
  return todo
}

export function updateTodo(
  dataDir: string,
  id: string,
  updates: { status?: Todo['status']; result?: string }
): Todo {
  const todos = loadTodos(dataDir)
  const index = todos.findIndex(t => t.id === id)
  if (index === -1) throw new Error(`Todo not found: ${id}`)

  const existing = todos[index]!
  const now = new Date().toISOString()

  const updated: Todo = {
    ...existing,
    ...updates,
    startedAt: updates.status === 'in_progress' ? now : existing.startedAt,
    completedAt: (updates.status === 'done' || updates.status === 'failed') ? now : existing.completedAt,
  }

  saveTodos(dataDir, [...todos.slice(0, index), updated, ...todos.slice(index + 1)])
  return updated
}

const PRIORITY_ORDER: Record<Todo['priority'], number> = { high: 0, medium: 1, low: 2 }

export function getNextTodo(dataDir: string): Todo | null {
  const todos = loadTodos(dataDir)
  const pending = todos.filter(t => t.status === 'pending')
  if (pending.length === 0) return null

  return [...pending].sort((a, b) => {
    const pDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
    if (pDiff !== 0) return pDiff
    return a.createdAt.localeCompare(b.createdAt)
  })[0]!
}

export function clearDone(dataDir: string): number {
  const todos = loadTodos(dataDir)
  const remaining = todos.filter(t => t.status !== 'done' && t.status !== 'failed')
  const removed = todos.length - remaining.length
  saveTodos(dataDir, remaining)
  return removed
}

export function recoverStuck(dataDir: string, timeoutMs: number): number {
  const todos = loadTodos(dataDir)
  const now = Date.now()
  let recovered = 0

  const updated = todos.map(t => {
    if (t.status === 'in_progress' && t.startedAt) {
      const elapsed = now - new Date(t.startedAt).getTime()
      if (elapsed > timeoutMs) {
        recovered++
        return { ...t, status: 'pending' as const, startedAt: undefined }
      }
    }
    return t
  })

  if (recovered > 0) {
    saveTodos(dataDir, updated)
  }
  return recovered
}
