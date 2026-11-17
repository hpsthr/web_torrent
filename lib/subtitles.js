import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { FFMPEG } from './ffmpeg.js'
import { extensionOf } from './media.js'
import { parseFirstJsonDocument } from './library.js'

const execFileAsync = promisify(execFile)

/**
 * Bitmap subtitle formats (BluRay PGS, DVD VobSub) are pictures, not text. They
 * cannot be turned into WebVTT without OCR, so they are reported but not offered
 * as tracks.
 */
const IMAGE_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'dvdsub'
])

export function isTextSubtitle (codec) {
  return Boolean(codec) && !IMAGE_SUBTITLE_CODECS.has(codec)
}

/** Turn ffprobe's subtitle streams into something the UI can offer. */
export function describeSubtitleStreams (streams = []) {
  return streams
    .filter(s => s.codec_type === 'subtitle')
    .map(s => {
      const tags = s.tags ?? {}
      const disposition = s.disposition ?? {}
      return {
        streamIndex: s.index,
        codec: s.codec_name,
        language: (tags.language ?? '').toLowerCase() || null,
        title: tags.title ?? null,
        forced: disposition.forced === 1,
        default: disposition.default === 1,
        hearingImpaired: disposition.hearing_impaired === 1,
        text: isTextSubtitle(s.codec_name)
      }
    })
}

/**
 * Extract one embedded subtitle stream as WebVTT.
 *
 * WebVTT is the only format browsers render, so an SRT/ASS track inside an MKV has
 * to be converted. Reading through the range endpoint means this works while the
 * file is still downloading - subtitle packets are small and scattered.
 */
export async function extractSubtitleToVtt ({ input, streamIndex, outputPath, timeoutMs = 120000 }) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  const partial = `${outputPath}.part`
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', input,
    '-map', `0:${streamIndex}`,
    '-f', 'webvtt',
    partial
  ]
  try {
    await execFileAsync(FFMPEG, args, { timeout: timeoutMs, maxBuffer: 4 << 20 })
    const text = await fs.readFile(partial, 'utf8')
    if (!text.startsWith('WEBVTT') || !/\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\s+-->/.test(text)) {
      throw new Error('conversion produced no subtitle cues')
    }
    await fs.rename(partial, outputPath)
    return { path: outputPath, bytes: Buffer.byteLength(text) }
  } catch (err) {
    await fs.rm(partial, { force: true }).catch(() => {})
    throw new Error(`could not extract subtitle track ${streamIndex}: ${err.stderr?.slice(-300) || err.message}`)
  }
}

/** Plain SRT -> WebVTT, used when the source is already text we can handle. */
export function srtToVtt (input) {
  const body = String(input)
    .replace(/\r+/g, '')
    .replace(/^\uFEFF/, '')
    // SRT uses a comma for milliseconds, WebVTT a full stop.
    .replace(/^(\d{1,2}:\d{2}:\d{2}),(\d{3})/gm, '$1.$2')
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
  return `WEBVTT\n\n${body.trim()}\n`
}

/** Convert any text subtitle file to WebVTT, via ffmpeg so ASS/SSA also work. */
export async function convertToVtt ({ inputPath, outputPath, timeoutMs = 60000 }) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  const partial = `${outputPath}.part`
  try {
    await execFileAsync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', inputPath, '-f', 'webvtt', partial
    ], { timeout: timeoutMs, maxBuffer: 4 << 20 })
    const text = await fs.readFile(partial, 'utf8')
    if (!text.startsWith('WEBVTT') || !/\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\s+-->/.test(text)) {
      throw new Error('conversion produced no subtitle cues')
    }
    await fs.rename(partial, outputPath)
    return outputPath
  } catch (err) {
    await fs.rm(partial, { force: true }).catch(() => {})
    // Fall back to a plain SRT rewrite when ffmpeg cannot parse it.
    const raw = await fs.readFile(inputPath, 'utf8').catch(() => null)
    if (raw && /\d{1,2}:\d{2}(:\d{2})?[,.]\d{3}/.test(raw)) {
      await fs.writeFile(outputPath, srtToVtt(raw), 'utf8')
      return outputPath
    }
    throw new Error(`could not convert subtitle: ${err.stderr?.slice(-300) || err.message}`)
  }
}

/* --------------------------------------------------------- OpenSubtitles -- */

const OS_BASE = process.env.OPENSUBTITLES_BASE_URL || 'https://api.opensubtitles.com/api/v1'

/**
 * fetch() hides the real network error inside `cause`; surface it so a failure
 * says something useful (DNS, TLS, connection reset) instead of "fetch failed".
 */
async function osFetch (url, options = {}, { retries = 3 } = {}) {
  let lastErr = null
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options)
    } catch (err) {
      lastErr = err
      // Cloudflare / transient network resets are common with this API. A short
      // backoff usually succeeds on the next try, so a one-off ECONNRESET no
      // longer kills the search panel.
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 250 * attempt))
      }
    }
  }
  const cause = lastErr?.cause?.code || lastErr?.cause?.message || ''
  throw new Error(`Could not reach OpenSubtitles (${lastErr?.message}${cause ? `: ${cause}` : ''})`)
}

export function openSubtitlesKey () {
  return process.env.OPENSUBTITLES_API_KEY || process.env.OSDB_API_KEY || ''
}

/**
 * Headers for the OpenSubtitles API.
 *
 * `Content-Type` is deliberately only sent when there is a body: attaching it to a
 * GET makes the API's edge reject the request outright.
 */
function osHeaders (apiKey, { json = false } = {}) {
  const headers = {
    'Api-Key': apiKey,
    'User-Agent': process.env.OPENSUBTITLES_USER_AGENT || 'webtorent v1.0',
    Accept: 'application/json'
  }
  if (json) headers['Content-Type'] = 'application/json'
  return headers
}

/**
 * Guess a searchable title from a torrent/file name.
 *
 * Release names carry a lot of noise (resolution, codec, group). Stripping it
 * gives OpenSubtitles a much better chance of matching the right film.
 */
export function guessTitle (rawName) {
  let name = String(rawName || '')
    .split(/[/\\]/).pop()                      // drop any directory part
    .replace(/\.[a-z0-9]{2,4}$/i, '')            // extension
    // File size, before dots become spaces ("2.7GB" must not become "2 7GB").
    .replace(/\b\d+(?:\.\d+)?\s?(?:gb|mib|mb|gib)\b/gi, ' ')

  // A leading site prefix is written "site.com - Title". Requiring spaces around
  // the dash is what keeps it from eating part of a real name: release names use
  // dots and hyphens with no spaces ("Show.S01E03.720p.WEB-DL").
  name = name.replace(/^(?:www\.[^\s]+|[a-z0-9-]+(?:\.[a-z0-9-]+)+)\s+[-–]\s+/i, ' ')

  name = name
    .replace(/[._]+/g, ' ')
    .replace(/[\[\](){}]/g, ' ')
    // release metadata
    .replace(/\b(1080p|720p|2160p|480p|4k|uhd|hdr(?:10)?|dolby\s?vision|dvdscr|dvdrip|web[- ]?dl|webrip|bluray|blu ray|brrip|bdrip|hdtv|remux|proper|repack|extended|unrated|imax|x264|x265|h ?264|h ?265|hevc|avc|aac|ac3|eac3|ddp ?5 ?1|dd5 ?1|dts|truehd|atmos|10bit|8bit|mp4|mkv|avi|mov|m4v|multi|dual)\b/gi, ' ')
    .replace(/\b(?:xx+|www|torrent\w*|yts|yify|rarbg|p2p|scene|split scenes|xxxclub|xc)\b/gi, ' ')
    .replace(/\b(?:s\d{2}\s?e\d{2}|season\s?\d+|episode\s?\d+)\b/gi, ' ')
    .replace(/[-–_]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[\s-]+|[\s-]+$/g, '')

  return name || String(rawName || '')
}

/** ISO 639-3 → ISO 639-1 for `srclang`, and for matching spoken vs subtitle language. */
const LANG3_TO_1 = {
  eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt',
  dut: 'nl', nld: 'nl', pol: 'pl', rus: 'ru', ara: 'ar', hin: 'hi', tur: 'tr', jpn: 'ja',
  kor: 'ko', chi: 'zh', zho: 'zh'
}

export function normalizeLang (language) {
  const code = String(language || '').trim().toLowerCase()
  if (!code) return null
  if (code.length === 3) return LANG3_TO_1[code] ?? code
  return code.slice(0, 2)
}

/** Best-effort language guess from a sidecar file name ("English.srt", "SDH.eng.HI.srt"). */
export function guessLanguageFromName (fileName) {
  const base = String(fileName || '').replace(/\.[a-z0-9]{2,4}$/i, '')
  const tokens = base.toLowerCase().split(/[^a-z]+/).filter(Boolean)
  const named = {
    english: 'en', eng: 'en', spanish: 'es', spa: 'es', french: 'fr', fre: 'fr', fra: 'fr',
    german: 'de', ger: 'de', deu: 'de', italian: 'it', ita: 'it', portuguese: 'pt', por: 'pt',
    dutch: 'nl', dut: 'nl', polish: 'pl', pol: 'pl', russian: 'ru', rus: 'ru',
    arabic: 'ar', ara: 'ar', hindi: 'hi', hin: 'hi', turkish: 'tr', tur: 'tr',
    japanese: 'ja', jpn: 'ja', korean: 'ko', kor: 'ko', chinese: 'zh', chi: 'zh',
    canada: null, canadian: null, 'latin': null, american: null, sdh: null, hi: null
  }
  for (const token of tokens) {
    const lang = named[token]
    if (lang) return lang
  }
  // Tokens like "Canadian.fre" / "Latin American.spa" carry the code last.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const lang = named[tokens[i]]
    if (lang) return lang
  }
  return null
}

/* ---------------------------------------------------------- timing shift -- */

/** `scale` presets for the classic frame-rate mismatches (24 ↔ 23.976, …). */
export const SYNC_SCALES = [
  { value: 1, label: 'Auto (1×)' },
  { value: 24 / 23.976, label: '24 → 23.976 fps' },
  { value: 23.976 / 24, label: '23.976 → 24 fps' },
  { value: 25 / 24, label: '25 → 24 fps' },
  { value: 24 / 25, label: '24 → 25 fps' }
]

function toMs (stamp) {
  const full = /^(\d{2}):(\d{2}):(\d{2})[.,](\d{3})$/.exec(String(stamp).trim())
  if (full) {
    return ((Number(full[1]) * 3600) + (Number(full[2]) * 60) + Number(full[3])) * 1000 + Number(full[4])
  }
  const short = /^(\d{2}):(\d{2})[.,](\d{3})$/.exec(String(stamp).trim())
  if (short) return ((Number(short[1]) * 60) + Number(short[2])) * 1000 + Number(short[3])
  return null
}

function toStamp (ms) {
  const total = Math.max(0, Math.round(ms))
  const h = Math.floor(total / 3600000)
  const m = Math.floor((total % 3600000) / 60000)
  const s = Math.floor((total % 60000) / 1000)
  const r = total % 1000
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(r, 3)}`
}

/**
 * Shift every cue in a WebVTT document by a constant offset (ms) and, when
 * `scale ≠ 1`, rescale timestamps (frame-rate drift fix). Cue durations are
 * preserved; cues that would end before zero are dropped, ones starting
 * before zero are clamped to zero.
 *
 * Browsers expose TextTrack cues as read-only, so a subtitle offset can only
 * be applied by rewriting the track itself — which is what serving does with
 * `?offset=` (see server.js `/subs/...`).
 */
export function shiftVttTimestamps (input, { offsetMs = 0, scale = 1 } = {}) {
  const offset = Number(offsetMs) || 0
  const factor = Number(scale) || 1
  if (offset === 0 && factor === 1) return String(input)
  const lines = String(input).replace(/\r+/g, '').split('\n')
  const out = []
  for (const line of lines) {
    const match = /^(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s+-->\s+(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})(.*)$/.exec(line)
    if (!match) {
      out.push(line)
      continue
    }
    const startMs = toMs(match[1])
    const endMs = toMs(match[2])
    if (startMs === null || endMs === null) {
      out.push(line)
      continue
    }
    const nextStart = startMs * factor + offset
    const nextEnd = endMs * factor + offset
    if (nextEnd <= 0) continue // cue is entirely before the film now
    out.push(`${toStamp(Math.max(0, nextStart))} --> ${toStamp(nextEnd)}${match[3]}`)
  }
  return out.join('\n')
}

/* ------------------------------------------------------- result ranking -- */

/**
 * Re-rank OpenSubtitles hits for *this* video instead of blindly taking the
 * most-downloaded file (which is why the panel kept serving WEB-Rip subtitles
 * for a Blu-Ray source — same title, different cut, wrong timing).
 *
 * Scores release-name similarity to the video file name, resolution/source
 * agreement, language, provider rating, then download count as a tie-break.
 */
export function rankSubtitleResults (results, { videoName = '', language = 'en' } = {}) {
  const want = normalizeLang(language) || 'en'
  const videoTokens = new Set(guessTitle(videoName).toLowerCase().split(/\s+/).filter(t => t.length > 2))
  const videoText = String(videoName).toLowerCase()
  const sourceTag = s => (s ? new RegExp(`\\b${s}\\b`).test(videoText) : false)

  const scored = (results ?? []).map(item => {
    const pool = `${item.release || ''} ${item.fileName || ''}`.toLowerCase()
    const tokens = new Set(guessTitle(pool).toLowerCase().split(/\s+/).filter(t => t.length > 2))
    let overlap = 0
    for (const token of tokens) if (videoTokens.has(token)) overlap++
    let score = overlap * 10
    for (const tag of ['1080p', '720p', '2160p', 'webrip', 'bluray', 'web-dl', 'webdl', 'hdtv', 'dvdscr', 'dvdrip']) {
      if (sourceTag(tag)) score += pool.includes(tag.replace('-', ' ')) || pool.includes(tag) ? 6 : -6
    }
    if (normalizeLang(item.language) === want) score += 8
    if (Number.isFinite(item.ratings) && item.ratings > 0) score += item.ratings * 2
    score += Math.log10((item.downloads || 0) + 10) // popularity, only a tie-break
    return { item, score }
  })
  return scored.sort((a, b) => b.score - a.score).map(({ item }) => item)
}

export async function searchOpenSubtitles ({ query, languages = ['en'], year, apiKey = openSubtitlesKey(), timeoutMs = 20000 }) {
  if (!apiKey) throw new Error('OpenSubtitles is not configured. Set OPENSUBTITLES_API_KEY to enable it.')
  const params = new URLSearchParams({
    query: guessTitle(query),
    languages: languages.join(','),
    order_by: 'download_count',
    order_direction: 'desc'
  })
  if (year) params.set('year', String(year))

  const res = await osFetch(`${OS_BASE}/subtitles?${params}`, {
    headers: osHeaders(apiKey),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new Error(`OpenSubtitles search failed (${res.status})`)
  const json = await res.json()

  return (json.data ?? []).map(entry => {
    const attrs = entry.attributes ?? {}
    const files = attrs.files ?? []
    const feature = attrs.feature_details ?? {}
    return {
      fileId: files[0]?.file_id ?? null,
      language: attrs.language ?? null,
      release: attrs.release ?? null,
      fileName: files[0]?.file_name ?? null,
      fileNames: files.map(f => f.file_name).filter(Boolean),
      downloads: attrs.download_count ?? 0,
      ratings: Number(attrs.ratings) || 0,
      hearingImpaired: Boolean(attrs.hearing_impaired),
      foreignParts: Boolean(attrs.foreign_parts_only),
      title: feature.title ?? null,
      year: feature.year ?? null,
      fps: attrs.fps ?? null
    }
  }).filter(r => r.fileId)
}

/** Ask OpenSubtitles for a download link, then fetch the bytes. */
export async function downloadOpenSubtitle ({ fileId, apiKey = openSubtitlesKey(), timeoutMs = 30000 }) {
  if (!apiKey) throw new Error('OpenSubtitles is not configured. Set OPENSUBTITLES_API_KEY to enable it.')

  const res = await osFetch(`${OS_BASE}/download`, {
    method: 'POST',
    headers: osHeaders(apiKey, { json: true }),
    body: JSON.stringify({ file_id: Number(fileId) }),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (res.status === 406) throw new Error('OpenSubtitles download quota reached for today.')
  if (!res.ok) throw new Error(`OpenSubtitles download failed (${res.status})`)
  const json = await res.json()
  if (!json.link) throw new Error('OpenSubtitles did not return a download link')

  const file = await osFetch(json.link, { signal: AbortSignal.timeout(timeoutMs) })
  if (!file.ok) throw new Error(`could not fetch the subtitle file (${file.status})`)
  const raw = Buffer.from(await file.arrayBuffer())

  return {
    fileName: json.file_name ?? 'subtitle.srt',
    remaining: json.remaining ?? null,
    buffer: await maybeDecompress(raw)
  }
}

/**
 * OpenSubtitles hands back plain SRT, gzip or a zip archive depending on the
 * upload. Normalise all three to the raw subtitle text.
 */
export async function maybeDecompress (buf) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return zlib.gunzipSync(buf)
  }
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    // zip: `unzip -p` streams the first entry to stdout
    const tmp = path.join(process.env.TMPDIR || '/tmp', `sub-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`)
    await fs.writeFile(tmp, buf)
    try {
      const { stdout } = await execFileAsync('unzip', ['-p', tmp], { maxBuffer: 32 << 20, encoding: 'buffer' })
      return Buffer.from(stdout)
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
  }
  return buf
}

/* ------------------------------------------------------------- the store -- */

/**
 * Downloaded subtitles are kept next to the video, so they survive a restart and
 * never have to be fetched twice.
 */
export class SubtitleStore {
  constructor (dataDir) {
    this.dir = path.join(dataDir, '.subs')
    this._writes = new Map()
    this._tmpSeq = 0
  }

  infoHashDir (infoHash) {
    return path.join(this.dir, infoHash)
  }

  /** Sanitised, unique file name for a downloaded track. */
  targetPath (infoHash, fileIndex, language, label, fileId = null) {
    const slug = String(label || 'subtitle')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'subtitle'
    // Two different provider files can share a 48-char label prefix; including
    // the provider id keeps their cache entries from overwriting each other.
    const suffix = fileId ? `-${String(fileId).slice(0, 32)}` : ''
    return path.join(this.infoHashDir(infoHash), `${fileIndex}-${language || 'xx'}-${slug}${suffix}.vtt`)
  }

  /** A previously downloaded subtitle for this exact OpenSubtitles file id. */
  async findByFileId (infoHash, fileIndex, fileId) {
    const index = await this.readIndex(infoHash)
    const entry = index[`${fileIndex}:${fileId}`]
    if (!entry) return null
    const full = path.join(this.infoHashDir(infoHash), entry.id)
    try {
      await fs.access(full)
    } catch {
      return null
    }
    return { id: entry.id, language: entry.language ?? null, label: entry.label ?? entry.id }
  }

  /** Remember which OpenSubtitles id produced which cached file. */
  async remember (infoHash, fileIndex, fileId, { id, language, label }) {
    return this._enqueue(infoHash, async () => {
      const index = await this.readIndex(infoHash)
      index[`${fileIndex}:${fileId}`] = { id, language, label, at: new Date().toISOString() }
      await fs.mkdir(this.infoHashDir(infoHash), { recursive: true })
      await this._writeAtomic(this.indexPath(infoHash), JSON.stringify(index, null, 2))
      return index
    })
  }

  /** Serialize writes to one index so concurrent downloads cannot tear it. */
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

  indexPath (infoHash) {
    return path.join(this.infoHashDir(infoHash), 'index.json')
  }

  async readIndex (infoHash) {
    let text
    try {
      text = await fs.readFile(this.indexPath(infoHash), 'utf8')
    } catch {
      return {}
    }
    try {
      return JSON.parse(text)
    } catch {
      try {
        // A torn write must not silently drop every cached mapping. Recover the
        // first complete document (see lib/library.js) and rewrite it clean.
        const { value } = parseFirstJsonDocument(text)
        await this._writeAtomic(this.indexPath(infoHash), JSON.stringify(value, null, 2))
        return value
      } catch {
        return {}
      }
    }
  }

  async list (infoHash, fileIndex) {
    let entries
    try {
      entries = await fs.readdir(this.infoHashDir(infoHash))
    } catch {
      return []
    }
    const prefix = `${fileIndex}-`
    const out = []
    for (const name of entries) {
      if (!name.startsWith(prefix) || !name.endsWith('.vtt')) continue
      const rest = name.slice(prefix.length)
      // Extracted embedded tracks are already listed as embedded tracks - the
      // cached file behind them is an implementation detail, not a second entry.
      // File name shape is "<index>-<lang>-embedded-<stream>.vtt".
      if (/^[a-z]{2,3}-embedded-\d+\.vtt$/i.test(rest)) continue
      const stat = await fs.stat(path.join(this.infoHashDir(infoHash), name)).catch(() => null)
      if (!stat) continue
      const [language] = rest.split('-')
      out.push({
        kind: 'external',
        id: name,
        language: language === 'xx' ? null : language,
        label: rest.replace(/^[a-z]{2,3}-/, '').replace(/-\d{4,32}\.vtt$/, '').replace(/\.vtt$/, '').replace(/-/g, ' '),
        bytes: stat.size,
        addedAt: stat.mtime.toISOString()
      })
    }
    return out
  }

  async remove (infoHash, id) {
    const target = path.join(this.infoHashDir(infoHash), path.basename(id))
    await fs.rm(target, { force: true })
  }
}
