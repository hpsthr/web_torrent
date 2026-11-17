import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './env.js'

/**
 * Persistent, append-only error/debug log.
 *
 * console.log goes to the terminal that launched `npm run dev`, which is gone
 * the moment that window closes. When something fails overnight (a subtitle
 * search, an ffmpeg pipeline, a stalled seek) we want a record we can read the
 * next morning — so every server log line is also appended to ./data/app.log.
 *
 * The file is capped (default 2 MB) and rotated once to app.log.1 to keep it
 * bounded. Nothing here throws: logging must never take down playback.
 */
const LOG_PATH = path.join(DATA_DIR, 'app.log')
const ROTATED_PATH = `${LOG_PATH}.1`
const MAX_BYTES = Number(process.env.LOG_MAX_BYTES || 2 * 1024 * 1024)

let rotating = false

function stamp () {
  return new Date().toISOString().slice(11, 19) // HH:MM:SS, matches server.js
}

/** Append one line (multi-line messages are flattened) to the persistent log. */
export function appendLog (args) {
  try {
    const text = args.map(a => {
      if (a instanceof Error) return `${a.message}${a.stack ? `\n${a.stack}` : ''}`
      if (typeof a === 'object') {
        try { return JSON.stringify(a) } catch { return String(a) }
      }
      return String(a)
    }).join(' ').replace(/\r?\n/g, ' | ')
    fs.appendFileSync(LOG_PATH, `${stamp()} ${text}\n`)
    rotateIfNeeded()
  } catch { /* logging is best-effort */ }
}

function rotateIfNeeded () {
  if (rotating) return
  try {
    if (fs.statSync(LOG_PATH).size < MAX_BYTES) return
  } catch {
    return
  }
  rotating = true
  try {
    // Keep one generation; older history is intentionally dropped.
    try { fs.unlinkSync(ROTATED_PATH) } catch { /* none yet */ }
    fs.renameSync(LOG_PATH, ROTATED_PATH)
  } catch { /* best-effort */ } finally {
    rotating = false
  }
}

/** Log an error with its context, e.g. logError('subtitles/search', err). */
export function logError (context, err) {
  appendLog([`[ERROR ${context}]`, err])
}

/** Install process-wide handlers so crashes leave a trace in app.log. */
export function installCrashLogging () {
  process.on('uncaughtException', err => {
    logError('uncaughtException', err)
    console.error('[fatal] uncaught exception:', err)
    // Do not exit: a stray error should not kill playback. The log records it.
  })
  process.on('unhandledRejection', reason => {
    logError('unhandledRejection', reason)
  })
}
