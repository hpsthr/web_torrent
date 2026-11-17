import fs from 'node:fs/promises'
import path from 'node:path'
import { allocatedBytes } from './storage.js'

/**
 * Persistent record of everything this app has opened.
 *
 * Sidecars live next to the torrent data in ./data:
 *   <infoHash>.torrent  bencoded metadata, so a replay needs no peers at all
 *   <infoHash>.json     name, files, resume position, prepared copy
 *
 * Keeping the .torrent means a saved video can be re-opened instantly and
 * offline: WebTorrent parses it, verifies the pieces already on disk, and the
 * file is immediately playable again.
 *
 * Two invariants keep those sidecars trustworthy across a restart:
 *  - every write is queued per infoHash and renamed into place atomically, so
 *    a process killed mid-save (npm run dev is stopped the same way) leaves
 *    either the old complete file or the new complete file, never a tear;
 *  - a read that finds trailing garbage after a complete JSON document recovers
 *    the document and rewrites it clean, instead of losing the whole record.
 */
export class Library {
  constructor (dir, { log = (...args) => console.log(...args) } = {}) {
    this.dir = dir
    this.log = log
    this._writes = new Map()
    this._tmpSeq = 0
  }

  torrentPath (infoHash) {
    return path.join(this.dir, `${infoHash}.torrent`)
  }

  metaPath (infoHash) {
    return path.join(this.dir, `${infoHash}.json`)
  }

  /** Serialize writes to one sidecar so concurrent patches cannot interleave. */
  _enqueue (infoHash, fn) {
    const key = String(infoHash)
    const previous = this._writes.get(key) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(fn)
    const settled = task.catch(() => {})
    this._writes.set(key, settled)
    settled.finally(() => {
      if (this._writes.get(key) === settled) this._writes.delete(key)
    })
    return task
  }

  /** Write to a temp file then rename, so the visible path is never half-written. */
  async _writeAtomic (filePath, data) {
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${++this._tmpSeq}.tmp`)
    try {
      await fs.writeFile(tmp, data)
      await fs.rename(tmp, filePath)
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }

  async save (torrent, patch = {}) {
    const infoHash = torrent.infoHash
    return this._enqueue(infoHash, async () => {
      if (torrent.torrentFile) {
        await this._writeAtomic(this.torrentPath(infoHash), Buffer.from(torrent.torrentFile))
      }
      const existing = await this._readMeta(infoHash)
      const meta = {
        ...existing,
        ...describeTorrent(torrent),
        ...patch,
        infoHash,
        addedAt: existing?.addedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      await this._writeAtomic(this.metaPath(infoHash), JSON.stringify(meta, null, 2))
      return meta
    })
  }

  async read (infoHash) {
    return this._readMeta(infoHash)
  }

  async _readMeta (infoHash) {
    const filePath = this.metaPath(infoHash)
    let text
    try {
      text = await fs.readFile(filePath, 'utf8')
    } catch {
      return null
    }
    try {
      return JSON.parse(text)
    } catch {
      // Fall through: a complete document may still be recoverable below.
    }
    try {
      const { value, end } = parseFirstJsonDocument(text)
      if (text.slice(end).trim() !== '') {
        this.log(`[library] repaired ${path.basename(filePath)}: dropped trailing garbage after the first complete JSON document`)
        await this._writeAtomic(filePath, JSON.stringify(value, null, 2))
      }
      return value
    } catch (err) {
      this.log(`[library] ignoring unreadable ${path.basename(filePath)}: ${err.message}`)
      return null
    }
  }

  async patch (infoHash, patch) {
    return this._enqueue(infoHash, async () => {
      const current = await this._readMeta(infoHash)
      if (!current) return null
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
      await this._writeAtomic(this.metaPath(infoHash), JSON.stringify(next, null, 2))
      return next
    })
  }

  async list () {
    let entries
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true })
    } catch {
      return []
    }
    const metas = []
    const seen = new Set()
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const infoHash = entry.name.slice(0, -'.json'.length)
      const meta = await this._readMeta(infoHash)
      if (!meta) {
        // A damaged sidecar must not hide downloadable data that is still here.
        // Keep a minimal entry so the library and the restore loop can find it;
        // reopening the torrent rewrites the full sidecar from the torrent file.
        if (await exists(this.torrentPath(infoHash))) {
          metas.push({ infoHash, files: [], hasTorrentFile: true, recovered: true, onDiskBytes: 0 })
          seen.add(infoHash)
        }
        continue
      }
      meta.infoHash = meta.infoHash ?? infoHash
      meta.hasTorrentFile = await exists(this.torrentPath(meta.infoHash))
      meta.onDiskBytes = await this.measure(meta)
      metas.push(meta)
      seen.add(meta.infoHash)
    }
    // Include .torrent files whose sidecar is missing entirely.
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.torrent')) continue
      const infoHash = entry.name.slice(0, -'.torrent'.length)
      if (seen.has(infoHash)) continue
      metas.push({ infoHash, files: [], hasTorrentFile: true, recovered: true, onDiskBytes: 0 })
    }
    return metas.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  }

  async torrentBuffer (infoHash) {
    try {
      return await fs.readFile(this.torrentPath(infoHash))
    } catch {
      return null
    }
  }

  async forget (infoHash) {
    return this._enqueue(infoHash, async () => {
      await fs.rm(this.torrentPath(infoHash), { force: true })
      await fs.rm(this.metaPath(infoHash), { force: true })
    })
  }

  /** Bytes actually present on disk for this torrent (preallocation tolerant). */
  async measure (meta) {
    let total = 0
    for (const file of meta.files ?? []) {
      try {
        total += await allocatedBytes(path.join(this.dir, file.path))
      } catch { /* not downloaded */ }
    }
    return total
  }
}

/**
 * Parse the first JSON document in `text`, reporting where it ends.
 *
 * A crash-torn write can leave a complete document plus stray bytes behind
 * (for example a second closing brace). Plain JSON.parse rejects the whole
 * file, which made the library treat the record as missing entirely. Scanning
 * the brackets (string-aware, so braces inside strings do not count) recovers
 * the document and exposes what followed it.
 */
export function parseFirstJsonDocument (text) {
  const source = String(text)
  let start = 0
  while (start < source.length && /\s/.test(source[start])) start++
  if (start >= source.length) throw new Error('empty file')
  let depth = 0
  let inString = false
  let escaped = false
  let started = false
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') {
      depth++
      started = true
      continue
    }
    if (ch === '}' || ch === ']') {
      depth--
      if (started && depth === 0) {
        return { value: JSON.parse(source.slice(start, i + 1)), end: i + 1 }
      }
      if (depth < 0) throw new Error('unbalanced brackets')
    }
  }
  throw new Error('incomplete JSON document')
}

export function describeTorrent (torrent) {
  return {
    infoHash: torrent.infoHash,
    name: torrent.name,
    length: torrent.length,
    pieceLength: torrent.pieceLength,
    files: torrent.files.map(file => ({
      name: file.name,
      path: file.path,
      length: file.length,
      type: file.type
    }))
  }
}

async function exists (filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Delete payload files recorded in a library sidecar.
 *
 * Used for items that are not loaded into WebTorrent right now (so there is no
 * torrent object to destroy) - for example when the storage guard evicts old
 * entries.
 */
export async function removeFiles (dataDir, files = []) {
  let freed = 0
  for (const file of files) {
    const full = path.join(dataDir, file.path)
    try {
      freed += await allocatedBytes(full)
      await fs.rm(full, { force: true })
    } catch { /* not present */ }
  }
  // Tidy up now-empty torrent folders; never touch the data dir itself.
  const dirs = new Set(files.map(file => String(file.path).split(/[/\\]/)[0]))
  for (const dir of dirs) {
    if (!dir || dir === '.') continue
    const full = path.join(dataDir, dir)
    if (full === path.resolve(dataDir)) continue
    try {
      const rest = await fs.readdir(full)
      if (rest.length === 0) await fs.rm(full, { recursive: true, force: true })
    } catch { /* not a directory */ }
  }
  return freed
}

/**
 * Remove a torrent's payload from disk.
 *
 * `torrent.destroy({ destroyStore: true })` unlinks the files the store opened,
 * which is the only reliable way to delete exactly this torrent's data (a
 * single-file torrent lives loose in ./data, so we must never `rm -rf` the
 * data directory itself).
 */
export async function deleteTorrentData (torrent, { log = () => {} } = {}) {
  const topLevel = new Set()
  const paths = []
  for (const file of torrent.files ?? []) {
    paths.push(path.join(torrent.path, file.path))
    topLevel.add(String(file.path).split(/[/\\]/)[0])
  }

  await new Promise(resolve => {
    try {
      torrent.destroy({ destroyStore: true }, () => resolve())
    } catch {
      resolve()
    }
  })

  let freed = 0
  for (const filePath of paths) {
    try {
      freed += await allocatedBytes(filePath)
      await fs.rm(filePath, { force: true })
    } catch { /* already gone */ }
  }

  // Drop directories the store leaves behind, but only for multi-file torrents
  // whose top-level entry is a real subdirectory.
  if (topLevel.size === 1) {
    const only = [...topLevel][0]
    if (only && only !== '.' && !paths.some(p => path.basename(p) === only)) {
      await fs.rm(path.join(torrent.path, only), { recursive: true, force: true }).catch(() => {})
    }
  }

  log(`deleted payload: ${freed} bytes`)
  return freed
}
