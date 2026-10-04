// Host half of the 糯籽 (Nuozi) desktop pet for DeepSeek Harness.
//
// Responsibilities:
//   1. Observe DSH working state (agents running, command errors, request
//      failures, approvals/questions waiting, user activity).
//   2. Publish a tiny JSON snapshot over an exact HTTP route that the Client
//      half polls.
//   3. Serve the sprite atlas and easter-egg frames as immutable assets.
//
// The Client half (client.js) owns rendering and the action-state semantics:
// idle when nothing happens, 握草 on errors/offline, and a hidden idle
// easter egg (its content is a surprise — keep it out of docs and labels).

import { readFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['webServer']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = join(PLUGIN_DIR, 'assets')
const STATE_PATH = '/nuozi-pet/state'
const ASSETS_PREFIX = '/nuozi-pet/assets'

const ASSET_FILES = new Set([
  'atlas.png',
  'grass.png',
  'dad-0.png', 'dad-1.png', 'dad-2.png', 'dad-3.png', 'dad-4.png', 'dad-5.png',
])

const MIME = { '.png': 'image/png' }

/** Tools whose failure counts as “命令执行有 error” (command execution error). */
const COMMAND_TOOLS = new Set([
  'bash', 'pwsh', 'run_code',
  'terminal_open', 'terminal_read', 'terminal_signal', 'terminal_close',
  'job_output', 'job_kill',
])

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export function apply(ctx, config = {}) {
  const cfg = {
    scale: clamp(Number(config.scale ?? 0.55) || 0.55, 0.3, 1.2),
    dadChance: clamp(Number(config.dadChance ?? 0.15) || 0, 0, 1),
    dadCheckIntervalMs: clamp(Number(config.dadCheckIntervalMs ?? 30000) || 30000, 8000, 600000),
    errorHoldMs: clamp(Number(config.errorHoldMs ?? 3200) || 3200, 800, 20000),
  }

  // ---- pet work-state machine -------------------------------------------

  /** Running agents by object identity. */
  const runningAgents = new Set()
  /** Sessions reported running through api-session/status. */
  const runningSessions = new Set()
  /** Currently open approval / user-question requests. */
  const waitingOpen = new Set()
  let lastError = null // { kind, at, detail }
  let lastUserAt = null
  let rev = 0

  const touch = () => { rev += 1 }

  const pulseError = (kind, detail) => {
    const text = typeof detail === 'string' ? detail.slice(0, 160) : ''
    lastError = { kind, at: Date.now(), detail: text }
    touch()
  }

  const isWorking = () => runningAgents.size > 0 || runningSessions.size > 0

  const snapshot = () => ({
    rev,
    now: Date.now(),
    working: isWorking(),
    waiting: waitingOpen.size > 0,
    error: lastError,
    userAt: lastUserAt,
    cfg,
  })

  // Agent lifecycle: idle ⇄ running.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') runningAgents.add(agent)
    else runningAgents.delete(agent)
    touch()
  })
  ctx.on('agent/disposed', ({ agent }) => {
    runningAgents.delete(agent)
    touch()
  })

  // Session-level running mirror (also covers protocol drivers).
  ctx.on('api-session/status', (sessionId, running) => {
    if (running) runningSessions.add(sessionId)
    else runningSessions.delete(sessionId)
    touch()
  })
  ctx.on('api-session/removed', (sessionId) => {
    runningSessions.delete(sessionId)
    touch()
  })

  // Command execution errors: isError results from command tools, or a
  // trailing non-zero “[exit code: N]” marker in their text output.
  ctx.on('tools/result', (exec, result) => {
    const name = typeof exec?.name === 'string' ? exec.name : ''
    if (!COMMAND_TOOLS.has(name)) return
    if (result && result.isError === true) {
      const block = (result.content ?? []).find?.((b) => b && b.type === 'text')
      pulseError('tool', block?.text ?? `tool ${name} failed`)
      return
    }
    const text = (result?.content ?? [])
      .filter?.((b) => b && b.type === 'text')
      .map?.((b) => b.text)
      .join('\n') ?? ''
    const match = /\[exit code:\s*(\d+)\]\s*$/u.exec(String(text).trimEnd())
    if (match && Number(match[1]) !== 0) pulseError('tool', `exit code ${match[1]}`)
  })

  // Model request failures — this is where 断网 (network loss) shows up.
  ctx.on('agent/request-error', ({ failure }) => {
    const detail = failure?.message ?? failure?.error?.message ?? (typeof failure === 'string' ? failure : 'request failed')
    pulseError('network', String(detail))
  })

  // A step or whole turn errored.
  ctx.on('agent/error', ({ error }) => {
    pulseError('agent', error?.message ?? 'turn error')
  })

  // Agent failed outside a durable turn position.
  ctx.on('api-session/error', (_sessionId, message) => {
    pulseError('session', message)
  })

  // Waiting: approvals and structured user questions hold the pet in its
  // “waiting” pose. Pass-through waterfall listeners — semantics unchanged.
  ctx.on('approval/request', async (_req, next) => {
    const key = `approval:${_req?.id ?? waitingOpen.size}`
    waitingOpen.add(key)
    touch()
    try {
      return await next()
    } finally {
      waitingOpen.delete(key)
      touch()
    }
  })
  ctx.on('user-questions/request', async (_req, next) => {
    const key = `question:${_req?.id ?? waitingOpen.size}`
    waitingOpen.add(key)
    touch()
    try {
      return await next()
    } finally {
      waitingOpen.delete(key)
      touch()
    }
  })

  // One user-authored durable message → greeting wave on the pet.
  ctx.on('api-session/activity', () => {
    lastUserAt = Date.now()
    touch()
  })

  // ---- HTTP surface ------------------------------------------------------

  const serveJson = (response, body) => {
    response.statusCode = 200
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.end(JSON.stringify(body))
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_PATH,
    handler(request, response) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.statusCode = 405
        response.end()
        return
      }
      serveJson(response, snapshot())
    },
  }), 'nuozi-pet: state route')

  const assetCache = new Map() // name → { body: Buffer, etag: string }

  const loadAsset = async (name) => {
    const hit = assetCache.get(name)
    if (hit) return hit
    const body = await readFile(join(ASSET_DIR, name))
    const entry = { body, etag: `"${name}-${body.length}-${body.length.toString(36)}"` }
    assetCache.set(name, entry)
    return entry
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ASSETS_PREFIX,
    async handler(request, response) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.statusCode = 405
        response.end()
        return
      }
      // Only whitelisted basenames resolve; anything else 404s (no traversal).
      const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
        .slice(ASSETS_PREFIX.length).replace(/^[\\/]+/u, '')
      const name = normalize(relative).split(sep).pop()
      if (!ASSET_FILES.has(name)) {
        response.statusCode = 404
        response.end()
        return
      }
      try {
        const { body, etag } = await loadAsset(name)
        if (request.headers['if-none-match'] === etag) {
          response.statusCode = 304
          response.end()
          return
        }
        response.statusCode = 200
        response.setHeader('content-type', MIME['.png'])
        response.setHeader('cache-control', 'public, max-age=31536000, immutable')
        response.setHeader('etag', etag)
        response.end(request.method === 'HEAD' ? undefined : body)
      } catch {
        response.statusCode = 404
        response.end()
      }
    },
  }), 'nuozi-pet: assets route')
}
