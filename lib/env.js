import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Everything this app touches lives inside its own folder - no global installs,
 * no writes to ~/.cache, no payload dumped in the system temp dir.
 *
 * IMPORTANT: this module must be imported *before* `webtorrent` (and before
 * anything that pulls it in). WebTorrent captures `os.tmpdir()` at module load
 * time for its fallback store path, so TMPDIR has to be redirected first. ESM
 * evaluates imports depth-first in source order, which is why `server.js`
 * imports this file on the very first line.
 */

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DATA_DIR = process.env.WEBTORENT_DATA_DIR
  ? path.resolve(process.env.WEBTORENT_DATA_DIR)
  : path.join(ROOT, 'data')
export const TMP_DIR = path.join(DATA_DIR, '.tmp')
export const PUBLIC_DIR = path.join(ROOT, 'public')

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(TMP_DIR, { recursive: true })

// Redirect the temp dir so stray temp files land in ./data/.tmp, not /var/folders.
process.env.TMPDIR = TMP_DIR
process.env.TMP = TMP_DIR
process.env.TEMP = TMP_DIR

/**
 * Load .env.local if it exists (gitignored).
 *
 * Keeps API keys such as OPENSUBTITLES_API_KEY out of the repo and out of your
 * shell history, while still surviving a restart. Real environment variables win,
 * so an explicit `FOO=bar npm start` still overrides the file.
 */
function loadLocalEnv () {
  let text
  try {
    text = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match || line.trim().startsWith('#')) continue
    const [, key, rawValue] = match
    if (process.env[key] !== undefined) continue
    process.env[key] = rawValue.replace(/^["']|["']$/g, '')
  }
}

loadLocalEnv()

export const STORAGE_LIMIT_BYTES = toBytes(process.env.MAX_DATA_GB, 8) // hard ceiling for ./data
export const PREPARE_LIMIT_BYTES = toBytes(process.env.MAX_PREPARE_GB, 4) // biggest file we will remux to disk

export const PORT = Number(process.env.PORT || 5173)
export const HOST = process.env.HOST || '127.0.0.1'

/** Human-readable paths for the UI. */
export const PATHS = {
  root: ROOT,
  data: DATA_DIR,
  tmp: TMP_DIR,
  tmpdir: os.tmpdir()
}

function toBytes (value, fallbackGb) {
  const gb = value === undefined || value === '' ? fallbackGb : Number(value)
  if (!Number.isFinite(gb) || gb <= 0) return fallbackGb * 1024 ** 3
  return Math.round(gb * 1024 ** 3)
}
