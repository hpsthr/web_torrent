import fs from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR, STORAGE_LIMIT_BYTES } from './env.js'

/** Recursive size of a directory tree, in bytes. */
export async function dirSize (dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        try {
          total += await allocatedBytes(full)
        } catch { /* vanished mid-walk */ }
      }
    }
  }
  return total
}

/**
 * Bytes this file actually occupies on disk.
 *
 * WebTorrent's store preallocates every file in a torrent to its full length, so
 * `stat.size` reports the whole torrent even when almost nothing has been
 * downloaded. Using that as "space used" made the storage cap trip - and evict
 * real downloads - while the disk was still nearly empty. `stat.blocks` is the
 * figure that reflects reality; `size` is only a fallback for platforms that do
 * not report it.
 */
export async function allocatedBytes (filePath) {
  const stat = await fs.stat(filePath)
  return Number.isFinite(stat.blocks) && stat.blocks > 0 ? stat.blocks * 512 : stat.size
}

/**
 * Cached view of how much space ./data is using.
 *
 * The cache keeps the UI honest without walking the tree on every request; the
 * size of a torrent folder is only meaningful in seconds anyway.
 */
export class UsageMeter {
  constructor ({ dir = DATA_DIR, limitBytes = STORAGE_LIMIT_BYTES, ttlMs = 5000 } = {}) {
    this.dir = dir
    this.limitBytes = limitBytes
    this.ttlMs = ttlMs
    this._bytes = 0
    this._at = 0
    this._inflight = null
  }

  async measure () {
    if (this._inflight) return this._inflight
    this._inflight = dirSize(this.dir)
      .then(bytes => {
        this._bytes = bytes
        this._at = Date.now()
        return bytes
      })
      .finally(() => {
        this._inflight = null
      })
    return this._inflight
  }

  async usage () {
    if (Date.now() - this._at > this.ttlMs) await this.measure()
    return { bytes: this._bytes, limitBytes: this.limitBytes, ratio: this.limitBytes ? this._bytes / this.limitBytes : 0 }
  }

  invalidate () {
    this._at = 0
  }
}
