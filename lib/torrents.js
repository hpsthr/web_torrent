import path from 'node:path'
import fs from 'node:fs/promises'
import WebTorrent from 'webtorrent'
import { DATA_DIR, STORAGE_LIMIT_BYTES, PREPARE_LIMIT_BYTES, TMP_DIR } from './env.js'
import { isVideoFile, extensionOf, mimeOf, planPlayback, isDirectContainer, isSubtitleFile } from './media.js'
import { probeInput, probeTorrentHead, summarizeProbe } from './probe.js'
import { buildFaststartLayout, readBoxHeader, topLevelBoxes } from './mp4.js'
import {
  SubtitleStore, extractSubtitleToVtt, convertToVtt, downloadOpenSubtitle,
  searchOpenSubtitles, openSubtitlesKey, guessTitle, guessLanguageFromName,
  normalizeLang, rankSubtitleResults, srtToVtt
} from './subtitles.js'
import { HeadPrefetcher } from './streaming.js'
import { Library, deleteTorrentData, removeFiles } from './library.js'
import { UsageMeter } from './storage.js'
import { preparedDir, preparedFilePath, startPrepare } from './prepare.js'
import { HttpError } from './http-error.js'

/**
 * Public trackers, concatenated with whatever the magnet already carries.
 *
 * Peer count is the single biggest lever on download speed, and a bare info hash
 * has no trackers at all. This is the ngosang "best" list
 * (https://github.com/ngosang/trackerslist) - the previous hand-written list had
 * several dead entries, which is how a torrent ends up with three peers and
 * 452 B/s.
 */
export const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.skynetcloud.site:6969/announce',
  'udp://tracker.qu.ax:6969/announce',
  'udp://tracker.tryhackx.org:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.nyaa.vc:6969/announce',
  'udp://tracker.corpscorp.online:80/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://retracker01-msk-virt.corbina.net:80/announce',
  'udp://tracker-udp.gbitt.info:80/announce',
  'udp://tracker2.dler.org:80/announce',
  'http://tracker.dler.org:6969/announce',
  'http://tracker.dler.com:6969/announce',
  'udp://tracker.gmi.gd:6969/announce',
  'udp://tracker.ducks.party:1984/announce',
  'http://tracker.renfei.net:8080/announce',
  'udp://tracker.farted.net:6969/announce',
  // WebRTC trackers still help when browser peers are present.
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz'
]

const IDLE_SESSION_MS = Number(process.env.SESSION_IDLE_MINUTES || 45) * 60 * 1000

/**
 * Seconds of video kept buffered in front of the playhead while playing.
 *
 * This is the shock absorber for a swarm whose speed fluctuates: as long as the
 * average is above the video's bitrate, a deep read-ahead rides out the dips
 * instead of stalling. At 6 Mbps, 180s is roughly 135 MB.
 */
const BUFFER_AHEAD_S = Number(process.env.BUFFER_AHEAD_SECONDS || 180)
/** ...and once playback stops, so a stopped player downloads ~a minute then goes quiet. */
const BUFFER_AHEAD_PAUSED_S = Number(process.env.BUFFER_AHEAD_PAUSED_SECONDS || 60)
/** Ceiling for the adaptive window: 20 minutes of video. */
const BUFFER_AHEAD_MAX_S = Number(process.env.BUFFER_AHEAD_MAX_SECONDS || 1200)

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32ToHex (input) {
  let bits = 0
  let value = 0
  let out = ''
  for (const char of String(input).toUpperCase().replace(/=+$/, '')) {
    const index = B32_ALPHABET.indexOf(char)
    if (index === -1) return null
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out += ((value >>> (bits - 8)) & 0xff).toString(16).padStart(2, '0')
      bits -= 8
    }
  }
  return out.length === 40 ? out : null
}

export function infoHashFromMagnet (magnet) {
  const match = /xt=urn:btih:([a-z0-9]+)/i.exec(String(magnet))
  if (!match) return null
  const hash = match[1]
  if (/^[0-9a-f]{40}$/i.test(hash)) return hash.toLowerCase()
  if (/^[a-z2-7]{32}$/i.test(hash)) return base32ToHex(hash)
  return null
}

/** Accept a magnet link, a bare info hash, or an http(s) .torrent URL. */
export function normalizeSource (input) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new HttpError(400, 'Paste a magnet link first.')
  if (/^magnet:/i.test(raw)) return { torrentId: raw, infoHash: infoHashFromMagnet(raw) }
  if (/^https?:\/\//i.test(raw)) return { torrentId: raw, infoHash: null }
  if (/^[0-9a-f]{40}$/i.test(raw)) return { torrentId: `magnet:?xt=urn:btih:${raw.toLowerCase()}`, infoHash: raw.toLowerCase() }
  if (/^[a-z2-7]{32}$/i.test(raw)) return { torrentId: `magnet:?xt=urn:btih:${raw.toUpperCase()}`, infoHash: base32ToHex(raw) }
  throw new HttpError(400, 'That does not look like a magnet link, info hash, or .torrent URL.')
}

function waitForMetadata (torrent, timeoutMs, log) {
  if (torrent.ready) return Promise.resolve(torrent)
  return new Promise((resolve, reject) => {
    let timer = null
    const cleanup = () => {
      clearTimeout(timer)
      torrent.off('metadata', onReady)
      torrent.off('error', onError)
      torrent.off('warning', onWarning)
    }
    const onReady = () => { cleanup(); resolve(torrent) }
    const onError = err => { cleanup(); reject(err) }
    const onWarning = err => log(`[torrent warning] ${err.message}`)
    timer = setTimeout(() => {
      cleanup()
      reject(new HttpError(504, `No peers answered within ${Math.round(timeoutMs / 1000)}s. The torrent may be dead, or trackers/DHT may be blocked on this network.`))
    }, timeoutMs)
    torrent.once('metadata', onReady)
    torrent.once('error', onError)
    torrent.on('warning', onWarning)
  })
}

async function probePath (filePath) {
  try {
    return summarizeProbe(await probeInput(filePath))
  } catch {
    return null
  }
}

async function statOrNull (filePath) {
  try {
    return await fs.stat(filePath)
  } catch {
    return null
  }
}

export class TorrentManager {
  constructor ({ dataDir = DATA_DIR, limitBytes = STORAGE_LIMIT_BYTES, log = console.log, rawBase = '' } = {}) {
    this.dataDir = dataDir
    this.log = log
    // Base URL of this server, so ffprobe can read a torrent file over the range
    // endpoint and seek inside it (needed to find a trailing moov atom).
    this.rawBase = rawBase
    this.library = new Library(dataDir, { log })
    this.subtitles = new SubtitleStore(dataDir)
    this.usage = new UsageMeter({ dir: dataDir, limitBytes })
    this.sessions = new Map()

    this.client = new WebTorrent({
      maxConns: Number(process.env.MAX_CONNS || 160),
      dht: true,
      lsd: true,
      // uTP off by default. Its native module emitted an unhandled
      // `UTP_ECONNRESET` that takes the whole process down mid-film, and measured
      // against TCP it found fewer peers (13 vs 25) for the same throughput.
      // Set ENABLE_UTP=1 if a swarm needs it.
      utP: process.env.ENABLE_UTP === '1',
      path: dataDir
    })
    // Throttles are methods in WebTorrent v3, not constructor options.
    if (process.env.THROTTLE_DOWNLOAD) this.client.throttleDownload(Number(process.env.THROTTLE_DOWNLOAD))
    if (process.env.THROTTLE_UPLOAD) this.client.throttleUpload(Number(process.env.THROTTLE_UPLOAD))
    this.client.on('error', err => this.log(`[webtorrent] ${err.message}`))
    this.client.on('warning', err => this.log(`[webtorrent warning] ${err.message}`))

    // Buffer window follows the playhead on a timer. The old code also called
    // autoUpgrade() here, which spawned a full-file ffmpeg re-encode ("seekable
    // copy") the moment a download finished. That second encoder runs at
    // ultrafast / 4 threads, pegs the CPU, starves the live playback stream and
    // is the reason the Mac heats up and playback buffers. Native on-demand
    // playback needs no seekable copy, so it is disabled by default. Opt back
    // in with ENABLE_SEEKABLE_COPY=1 if you ever want it.
    this.seekableCopyEnabled = process.env.ENABLE_SEEKABLE_COPY === '1'
    this._upgradeTimer = setInterval(() => {
      try {
        for (const session of this.sessions.values()) {
          if (session.torrent.destroyed) continue
          this.applyBufferWindow(session)
          if (this.seekableCopyEnabled) {
            this.autoUpgrade(session).catch(err => this.log(`[auto-upgrade] ${err.message}`))
          }
        }
      } catch (err) {
        this.log(`[upgrade-timer] ERROR: ${err.message}`)
      }
    }, 5000)
    this._upgradeTimer.unref?.()
  }

  /* ------------------------------------------------------------------ add -- */

  /**
   * Register a torrent and wait for its metadata. Nothing is downloaded at this
   * point (`deselect: true`), so adding a season pack costs a few KB, not GB.
   */
  async add (source, { timeoutMs = Number(process.env.METADATA_TIMEOUT_MS || 90000) } = {}) {
    const { torrentId } = normalizeSource(source)

    // WebTorrent v3: client.get() is async and parses the identifier itself.
    const existing = await this.client.get(torrentId)
    if (existing && !existing.destroyed) return this.attach(existing)

    const torrent = this.client.add(torrentId, {
      path: this.dataDir,
      deselect: true, // metadata only until the user actually plays something
      strategy: 'sequential',
      announce: DEFAULT_TRACKERS
    })

    try {
      await waitForMetadata(torrent, timeoutMs, this.log)
    } catch (err) {
      await new Promise(resolve => torrent.destroy(() => resolve())).catch(() => {})
      throw err
    }

    return this.attach(torrent)
  }

  /** Re-open a previously saved torrent straight from ./data (no peers needed). */
  async reopen (infoHash) {
    const existing = await this.client.get(infoHash)
    if (existing && !existing.destroyed) return this.attach(existing)

    const buffer = await this.library.torrentBuffer(infoHash)
    if (!buffer) throw new HttpError(404, 'No saved metadata for this item.')
    const torrent = this.client.add(buffer, { path: this.dataDir, deselect: true, strategy: 'sequential' })
    await waitForMetadata(torrent, 20000, this.log)
    return this.attach(torrent)
  }

  /**
   * Re-open every saved item still on disk, so a server restart does not look
   * like a stopped download. The source of truth is the `.torrent` file next
   * to the data: even if a `.json` sidecar is missing or damaged, the item is
   * still found (Library.list synthesises an entry for it) and attaching the
   * reopened torrent rewrites the full sidecar. Pieces already downloaded are
   * preserved because WebTorrent's store verifies them in place.
   */
  async restoreAll () {
    const metas = await this.library.list()
    const pending = metas.filter(meta => meta.hasTorrentFile)
    this.log(`[restore] found ${pending.length} saved item(s)`)
    await Promise.allSettled(pending.map(async meta => {
      try {
        const session = await this.reopen(meta.infoHash)
        this.log(`[restore] re-opened ${session.torrent.name ?? meta.infoHash.slice(0, 8)}`)
      } catch (err) {
        this.log(`[restore] could not re-open ${String(meta.infoHash).slice(0, 8)}: ${err.message}`)
      }
    }))
  }

  attach (torrent) {
    let session = this.sessions.get(torrent.infoHash)
    if (session && session.torrent === torrent && !torrent.destroyed) return session

    session = {
      id: torrent.infoHash,
      torrent,
      createdAt: Date.now(),
      lastActionAt: Date.now(),
      prefetcher: new HeadPrefetcher(torrent),
      selectedFileIndex: null,
      probes: new Map(),
      prepare: null,
      prepareHandle: null,
      quotaBlocked: false,
      playhead: 0,
      paused: false,
      fileSelected: false,
      selectedForDownload: null,
      bufferSelection: null,
      faststart: new Map(),
      activeStreams: new Set()
    }
    this.sessions.set(torrent.infoHash, session)
    torrent.on('error', err => this.log(`[torrent ${torrent.infoHash.slice(0, 8)}] ${err.message}`))

    if (torrent.torrentFile) {
      this.library.save(torrent).catch(err => this.log(`[library] ${err.message}`))
    }

    // Start pulling the likely feature immediately, and warm its index.
    //
    // Torrents are added metadata-only, which keeps a season pack cheap - but it
    // also means the swarm sits idle until someone presses Play, and only then
    // begins the slow business of finding peers and ramping up. Priming here means
    // that ramp happens while the viewer is still choosing a file.
    this.primeDownload(session).catch(err => this.log(`[prime] ${err.message}`))
    this.warmIndex(session).catch(err => this.log(`[warm] ${err.message}`))
    return session
  }

  /**
   * Wait until a torrent is actually usable.
   *
   * `waitForMetadata` resolves on the `metadata` event, but WebTorrent only sets
   * `torrent.ready` afterwards, once the store exists. Anything that touches pieces
   * (selecting a file, warming the index) has to wait for that - checking `ready`
   * straight after metadata always saw false, which is why priming silently did
   * nothing at all.
   */
  async waitReady (torrent, timeoutMs = 60000) {
    if (torrent.ready) return true
    if (torrent.destroyed) return false
    return new Promise(resolve => {
      const finish = ok => {
        clearTimeout(timer)
        torrent.off('ready', onReady)
        torrent.off('close', onClose)
        resolve(ok)
      }
      const onReady = () => finish(true)
      const onClose = () => finish(false)
      const timer = setTimeout(() => finish(false), timeoutMs)
      timer.unref?.()
      torrent.once('ready', onReady)
      torrent.once('close', onClose)
    })
  }

  /**
   * Select the most likely feature and let the swarm start on it now.
   *
   * Only the largest video file is selected, so a season pack still does not pull
   * every episode - but the film you are about to watch is already arriving by the
   * time you press Play, instead of starting from nothing.
   *
   * Set AUTO_DOWNLOAD=0 to restore metadata-only behaviour.
   */
  async primeDownload (session) {
    if (process.env.AUTO_DOWNLOAD === '0') return
    const torrent = session.torrent
    if (!await this.waitReady(torrent)) return

    const candidates = torrent.files
      .map((file, index) => ({ file, index }))
      .filter(({ file }) => isVideoFile(file.name) && file.length > 0)
    if (candidates.length === 0) return

    const biggest = candidates.reduce((a, b) => (b.file.length > a.file.length ? b : a))
    if (session.selectedForDownload === biggest.index) return

    biggest.file.select()
    session.selectedForDownload = biggest.index
    session.fileSelected = true
    // Also mark it as the file of interest, so the progress bar shows this download
    // instead of sitting at zero until something is played.
    if (session.selectedFileIndex === null) session.selectedFileIndex = biggest.index
    this.log(`[prime] downloading ${biggest.file.name} (${Math.round(biggest.file.length / 1e6)} MB) from the start`)
  }

  async warmIndex (session) {
    const torrent = session.torrent
    if (!await this.waitReady(torrent)) return
    const candidates = torrent.files
      .map((file, index) => ({ file, index }))
      .filter(({ file }) => isVideoFile(file.name) && isDirectContainer(file.name))
    if (candidates.length === 0) return
    const biggest = candidates.reduce((a, b) => (b.file.length > a.file.length ? b : a))
    const faststart = await this.detectFaststart(biggest.file)
    if (faststart === false) {
      const layout = await this.faststartLayout(session, biggest.index)
      if (layout && !layout.passthrough) {
        this.log(`[warm] index for ${biggest.file.name} ready before playback`)
      }
    }
  }

  get (id) {
    const session = this.sessions.get(String(id))
    if (!session || session.torrent.destroyed) throw new HttpError(404, 'That torrent is not open any more.')
    return session
  }

  /* ------------------------------------------------------------ buffering -- */

  /** Record where the viewer is, so the buffer window can follow them. */
  setPlayhead (session, { position, duration, paused } = {}) {
    if (Number.isFinite(Number(position))) session.playhead = Math.max(0, Number(position))
    if (Number.isFinite(Number(duration)) && Number(duration) > 0) {
      const index = session.selectedFileIndex
      if (index !== null && !session.probes.has(index)) {
        session.probes.set(index, { duration: Number(duration), video: null, audio: null })
      }
    }
    if (typeof paused === 'boolean') session.paused = paused
    this.applyBufferWindow(session)
  }

  /**
   * Bias the swarm towards the playhead.
   *
   * This deliberately does NOT deselect the rest of the file. Instant seeking
   * depends on the file completing so it can be turned into a seekable MP4, and
   * deselecting the tail would stop that from ever happening - which is exactly
   * the bug that made every seek fall back to a slow live-stream reload.
   *
   * So: the whole file stays selected, and the region around the playhead is
   * marked critical so it arrives first. The window only shrinks while paused,
   * and even then only down to a still-useful read-ahead.
   */
  applyBufferWindow (session) {
    const torrent = session.torrent
    if (!torrent || torrent.destroyed || !torrent.ready || !torrent.pieceLength) return

    const index = session.selectedFileIndex
    if (index === null) return
    const file = torrent.files[index]
    const duration = session.probes.get(index)?.duration ?? 0
    if (!file || !duration || file.done) return

    // Make sure the whole file stays queued: completing it is what unlocks the
    // seekable copy and therefore instant scrubbing. Tracked per file index -
    // with several videos in one torrent, switching files must select the new
    // one, not assume the old selection still applies.
    if (session.selectedForDownload !== index) {
      file.select()
      session.selectedForDownload = index
      session.fileSelected = true
    }

    // Adaptive read-ahead.
    //
    // A fixed window is wrong at both ends: too small for a 20 Mbps film on a slow
    // swarm, wasteful for a 1 Mbps clip on a fast one. The window is sized so the
    // buffer grows at least twice as fast as playback consumes it; when the swarm
    // cannot manage that, the window goes as deep as the limits allow so every
    // spare byte is spent getting further ahead (that head start is what turns a
    // stall into a pause you never notice).
    const requiredBps = duration > 0 ? (file.length * 8) / duration : 0
    const measuredBps = torrent.downloadSpeed || 0
    const headroom = requiredBps > 0 && measuredBps > 0 ? measuredBps / requiredBps : 2
    const scale = headroom >= 2 ? 1 : headroom >= 1 ? 2 : 4
    const ahead = session.paused
      ? BUFFER_AHEAD_PAUSED_S
      : Math.min(BUFFER_AHEAD_MAX_S, BUFFER_AHEAD_S * scale)

    const from = Math.max(0, session.playhead || 0)
    const to = Math.min(duration, from + ahead)

    const { pieceLength, pieces } = torrent
    const lastPiece = pieces.length - 1
    const toPieceOf = seconds =>
      Math.min(lastPiece, Math.max(0, Math.floor((file.offset + (seconds / duration) * file.length) / pieceLength)))

    const fromPiece = toPieceOf(from)
    const toPiece = toPieceOf(to)

    // Replace the previous window rather than stacking another on top of it.
    // Selecting a fresh range every few seconds used to leave hundreds of
    // overlapping selections behind, and the piece picker has to scan all of them
    // on every wire update - which made scheduling steadily worse during playback.
    const previous = session.bufferSelection
    if (previous && (previous.from !== fromPiece || previous.to !== toPiece)) {
      torrent.deselect(previous.from, previous.to)
    }

    torrent.select(fromPiece, toPiece, 1)
    torrent.critical(fromPiece, toPiece)
    session.bufferSelection = { from: fromPiece, to: toPiece }
  }

  /**
   * Stop the live conversion pipelines for a session - used when playback pauses.
   *
   * Only ffmpeg-backed streams are aborted. A plain file response (the seekable
   * MP4, a repaired MP4, or a native container served over Range) must be left
   * alone: destroying it kills the request the media element is reading from, and
   * the browser reports that as a playback error - which then triggered a fallback
   * to the live path and made the film stop dead on resume.
   */
  stopStreams (session) {
    for (const res of session.activeStreams) {
      if (!res.dshLivePipeline) continue
      try { res.destroy() } catch { /* already gone */ }
    }
    session.activeStreams.clear()
    // Nothing should be pulled while stopped beyond the paused window.
    this.applyBufferWindow(session)
  }

  /** A live ffmpeg pipeline is running - give it the CPU. */
  beginLive () {
    this.livePipelines = (this.livePipelines || 0) + 1
    if (this.livePipelines !== 1) return
    for (const session of this.sessions.values()) session.prepareHandle?.pause?.()
  }

  /** The live pipeline ended, so a paused prepare can continue. */
  endLive () {
    this.livePipelines = Math.max(0, (this.livePipelines || 0) - 1)
    if (this.livePipelines !== 0) return
    for (const session of this.sessions.values()) session.prepareHandle?.resume?.()
  }

  /** Cheap box-order check: is the index (moov) before the data (mdat)? */
  async detectFaststart (file) {
    try {
      const head = await this.readFileRange(file, 0, Math.min(256 * 1024, file.length) - 1, { torrent: this.sessions.get(file._torrent?.infoHash)?.torrent })
      const boxes = topLevelBoxes(head)
      const moov = boxes.findIndex(b => b.type === 'moov')
      const mdat = boxes.findIndex(b => b.type === 'mdat')
      if (moov !== -1 && (mdat === -1 || moov < mdat)) return true
      if (mdat !== -1 && moov === -1) return false
      return null // could not tell from this much of the file
    } catch {
      return null
    }
  }

  /* ------------------------------------------------- progressive MP4 repair -- */

  /** Read an exact byte range out of a torrent file, waiting for the pieces. */
  async readFileRange (file, start, end, { timeoutMs = 60000, torrent = null } = {}) {
    const length = end - start + 1
    if (length <= 0) return Buffer.alloc(0)

    // Ask the swarm for these pieces first. The index is what everything else
    // waits on, so it should never queue behind the rest of the file.
    if (torrent?.ready && torrent.pieceLength) {
      const lastPiece = torrent.pieces.length - 1
      const from = Math.max(0, Math.floor((file.offset + start) / torrent.pieceLength))
      const to = Math.min(lastPiece, Math.floor((file.offset + end) / torrent.pieceLength))
      torrent.select(from, to, 1)
      torrent.critical(from, to)
    }

    const chunks = []
    let size = 0
    const stream = file.createReadStream({ start, end })
    const timer = setTimeout(() => stream.destroy(new Error('timed out reading from the swarm')), timeoutMs)
    try {
      for await (const chunk of stream) {
        chunks.push(chunk)
        size += chunk.length
        if (size >= length) break
      }
    } finally {
      clearTimeout(timer)
      stream.destroy()
    }
    return Buffer.concat(chunks, size)
  }

  /**
   * Build (and cache) a faststart layout for an MP4 whose index sits at the end.
   *
   * Only the index and the first box headers are read from the swarm - a few MB at
   * most - and then the browser can play and seek the file natively. Without this
   * the file has to go through ffmpeg as a live stream, which is exactly what made
   * playback take seconds to start.
   */
  async faststartLayout (session, fileIndex) {
    const key = fileIndex
    if (session.faststart?.has(key)) return session.faststart.get(key)

    const torrent = session.torrent
    const file = torrent.files[fileIndex]
    if (!file) throw new HttpError(400, 'Unknown file index.')

    let layout = null
    try {
      const headLength = Math.min(1 << 20, file.length)
      const head = await this.readFileRange(file, 0, headLength - 1, { torrent })
      const boxes = topLevelBoxes(head)
      const mdat = boxes.find(b => b.type === 'mdat')
      const moovIndex = boxes.findIndex(b => b.type === 'moov')
      const mdatIndex = boxes.findIndex(b => b.type === 'mdat')

      // "Already faststart" means the index comes BEFORE the data - not merely
      // that it appears in the head. For a file smaller than the head read the
      // moov is always present, so testing for its presence alone would call
      // every small file faststart and skip the repair.
      if (moovIndex !== -1 && (mdatIndex === -1 || moovIndex < mdatIndex)) {
        layout = { passthrough: true }
      } else if (mdat) {
        const moovOffset = mdat.offset + mdat.size
        if (moovOffset + 8 <= file.length) {
          const header = await this.readFileRange(file, moovOffset, moovOffset + 15, { torrent })
          const moovHeader = readBoxHeader(header, 0)
          if (moovHeader && moovHeader.type === 'moov' && moovHeader.size > 0) {
            const moovEnd = Math.min(moovOffset + moovHeader.size, file.length)
            const moov = await this.readFileRange(file, moovOffset, moovEnd - 1, { torrent })
            layout = buildFaststartLayout({ head, moov, fileLength: file.length })
            if (layout) {
              this.log(`[mp4] relocated moov for ${file.name}: ${layout.shifted} chunk offsets shifted by ${layout.delta} bytes`)
            }
          }
        }
      }
    } catch (err) {
      this.log(`[mp4] could not build a faststart layout for ${file.name}: ${err.message}`)
      layout = null
    }

    if (!session.faststart) session.faststart = new Map()
    session.faststart.set(key, layout)
    return layout
  }

  /* ----------------------------------------------------------- seek fetching -- */

  /**
   * Fetch just the region a seek needs, then report when it is playable.
   *
   * Clicking 45:00 in a 2.9 GB film must not mean waiting for the first 45
   * minutes to arrive first. The timestamp maps to a byte range, the byte range
   * maps to a piece range, and only that range is pushed to the front of the
   * swarm's queue - this is the same idea the range-serving proxy in webtor's
   * self-hosted stack relies on. We then wait for *those* pieces and serve from
   * there, instead of the whole prefix.
   */
  /**
   * Push the pieces a seek needs to the front of the swarm queue.
   *
   * This used to *wait* for those pieces before answering, which added up to 90s
   * of dead time. It no longer waits: ffmpeg reads the torrent through the
   * range-serving endpoint, so its own Range requests block until the bytes are
   * there. Priming the queue is all that is needed - the data arrives while ffmpeg
   * is already starting up, instead of before it is allowed to.
   */
  async ensureSeekTarget (session, fileIndex, startSeconds, {
    duration = 0,
    lookaheadSeconds = 60,
    primeMs = Number(process.env.SEEK_PRIME_MS || 0),
    log = () => {}
  } = {}) {
    const torrent = session.torrent
    const file = torrent.files[fileIndex]
    if (!file || !duration || !torrent.ready) return { ok: false, reason: 'unknown' }
    if (file.done) return { ok: true, alreadyComplete: true }

    const { pieceLength, pieces } = torrent
    const lastPiece = pieces.length - 1
    const ratio = Math.max(0, Math.min(1, startSeconds / duration))

    // timestamp -> byte offset inside the file -> piece range inside the torrent
    const fileByte = Math.floor(ratio * file.length)
    const endByte = Math.min(
      file.length,
      Math.floor(((startSeconds + lookaheadSeconds) / duration) * file.length)
    )
    const from = Math.max(0, Math.floor((file.offset + fileByte) / pieceLength))
    const to = Math.min(lastPiece, Math.floor((file.offset + endByte) / pieceLength))

    // Matroska keeps its cue index at the very end of the file. Without those
    // pieces ffmpeg cannot land on an exact keyframe, so pull them in too.
    const cuePieces = Math.ceil((4 * 1024 * 1024) / pieceLength)
    const cueFrom = Math.max(0, lastPiece - cuePieces + 1)

    torrent.select(from, to, 1)
    torrent.critical(from, to)
    if (cueFrom > to) {
      torrent.select(cueFrom, lastPiece, 1)
      torrent.critical(cueFrom, lastPiece)
    }
    session.lastActionAt = Date.now()
    log(`seek ${Math.round(startSeconds)}s -> priming pieces ${from}-${to}${cueFrom > to ? ` + cues ${cueFrom}-${lastPiece}` : ''}`)

    // Brief head start only: enough for the first pieces to be requested, not
    // enough to make the viewer wait for the whole window.
    const deadline = Date.now() + primeMs
    while (Date.now() < deadline && !file.done && !torrent.destroyed) {
      await new Promise(resolve => setTimeout(resolve, 150))
    }

    return { ok: true, from, to, byteOffset: fileByte, primed: primeMs }
  }

  /* --------------------------------------------------------------- inspect -- */

  videoFiles (torrent) {
    return torrent.files
      .map((file, index) => ({ file, index }))
      .filter(({ file }) => isVideoFile(file.name))
      .map(({ file, index }) => ({
        index,
        name: file.name,
        length: file.length,
        extension: extensionOf(file.name),
        mime: mimeOf(file.name),
        direct: isDirectContainer(file.name),
        downloaded: file.downloaded,
        progress: file.progress,
        done: file.done
      }))
  }

  async probeFor (session, fileIndex) {
    if (session.probes.has(fileIndex)) return session.probes.get(fileIndex)
    const file = session.torrent.files[fileIndex]
    if (!file) throw new HttpError(400, 'Unknown file index.')

    let probe = null
    let faststart = null
    const directContainer = isDirectContainer(file.name)

    if (file.done) {
      probe = await probePath(this.diskPath(session.torrent, file))
      // A finished file still benefits from the repair: with the index at the end
      // the browser must fetch the tail before it can show a duration or seek.
      if (directContainer && probe?.video) {
        faststart = (await this.detectFaststart(file)) ?? false
      }
    } else if (directContainer) {
      // MP4/MOV/WebM: go straight to the range endpoint. ffprobe then fetches only
      // the box headers it needs and can reach a trailing moov, instead of us
      // pulling megabytes off the front of the file to discover it is not there.
      if (this.rawBase) {
        const viaHttp = await probePath(`${this.rawBase}/raw/${session.id}/${fileIndex}`)
        if (viaHttp?.video) {
          probe = viaHttp
          // Inconclusive detection is treated as "index at the end": the repair
          // path re-checks and serves the file raw when it turns out to be
          // faststart already, so guessing this way is always safe.
          faststart = (await this.detectFaststart(file)) ?? false
        }
      }
      if (!probe?.video) {
        probe = await probeTorrentHead(file, { tmpDir: TMP_DIR, log: msg => this.log(`[probe] ${msg}`) })
      }
    } else {
      // MKV/AVI keep their headers at the front, so a small head read is cheapest.
      probe = await probeTorrentHead(file, { tmpDir: TMP_DIR, log: msg => this.log(`[probe] ${msg}`) })
      if ((!probe || !probe.video || !probe.duration) && this.rawBase) {
        const viaHttp = await probePath(`${this.rawBase}/raw/${session.id}/${fileIndex}`)
        if (viaHttp?.video) probe = viaHttp
      }
    }

    const result = probe ? { ...probe, faststart } : null
    session.probes.set(fileIndex, result)
    return result
  }

  diskPath (torrent, file) {
    return path.join(torrent.path, file.path)
  }

  /**
   * How many bytes from the start of this file are contiguously on disk.
   *
   * Pieces arrive in any order, so a file can be 40% downloaded and still have a
   * hole at minute 3. Only a contiguous prefix is genuinely playable, and that is
   * what decides whether a seek target is available yet.
   */
  playablePrefix (torrent, file) {
    if (!torrent.ready) return 0
    // Cache for done files — the result never changes.
    if (file.done) return file.length
    const { bitfield, pieceLength, pieces } = torrent
    const fileStart = file.offset
    const fileEnd = file.offset + file.length
    let bytes = 0
    for (let i = 0; i < pieces.length; i++) {
      if (!bitfield.get(i)) break
      const pieceStart = i * pieceLength
      const overlap = Math.min(pieceStart + pieceLength, fileEnd) - Math.max(pieceStart, fileStart)
      if (overlap > 0) bytes += overlap
    }
    return Math.max(0, Math.min(bytes, file.length))
  }

  /** Timestamp up to which this file can be played right now. */
  playableSeconds (torrent, file, duration) {
    if (!duration || !file.length) return 0
    if (file.done) return duration
    return (this.playablePrefix(torrent, file) / file.length) * duration
  }

  /* ------------------------------------------------------------------ play -- */

  /**
   * Prepare a file for playback and report the strategy to use.
   *
   * `full` (default on) downloads the whole file up front. That is what makes the
   * other two player guarantees possible: the duration is known up front, and the
   * finished file can be converted once into a faststart MP4 that the browser can
   * actually scrub through.
   *
   * If the storage cap cannot fit the whole file we degrade to windowed streaming
   * rather than refuse to play, and say so in the response.
   */
  async play (id, fileIndex, { keepData, full = true, hevcSupported = false, audioCodecs = {} } = {}) {
    const session = this.get(id)
    const torrent = session.torrent
    const index = Number(fileIndex)

    if (!Number.isInteger(index) || index < 0 || index >= torrent.files.length) {
      throw new HttpError(400, 'Unknown file index.')
    }
    const file = torrent.files[index]
    if (!isVideoFile(file.name)) throw new HttpError(415, `${file.name} is not a video file.`)

    // One file at a time: drop any explicit "keep the whole file" selection from
    // a previously played file so it stops consuming bandwidth and disk.
    if (session.selectedFileIndex !== null && session.selectedFileIndex !== index) {
      const previous = torrent.files[session.selectedFileIndex]
      if (previous && !previous.done) previous.deselect()
    }

    session.selectedFileIndex = index
    if (typeof keepData === 'boolean') session.keepData = keepData
    session.lastActionAt = Date.now()
    session.prefetcher.useFile(file)
    session.prefetcher.seek(0)
    session.prefetcher.start()

    const probe = await this.probeFor(session, index)
    const plan = planPlayback({ fileName: file.name, probe, hevcSupported, audioCodecs })
    const prepared = await this.preparedInfo(torrent.infoHash, index)
    const sync = await this.savedSync(torrent.infoHash, index)
    const subtitle = await this.savedSubtitlePrefs(torrent.infoHash, index)

    let fullLoad = Boolean(full)
    let quotaLimited = false
    if (fullLoad && !prepared && !file.done) {
      const quota = await this.enforceLimit({
        protect: torrent.infoHash,
        neededBytes: Math.max(0, file.length - file.downloaded)
      })
      if (quota.ok) {
        file.select() // whole file, downloaded in order by the sequential strategy
        session.fileSelected = true
        session.selectedForDownload = index
      } else {
        fullLoad = false
        quotaLimited = true
        this.log(`[storage] not enough room for the full ${file.name} - streaming windows only`)
      }
    }
    session.fullLoad = fullLoad
    session.autoPrepareRan = Boolean(prepared)

    // Fetch and rewrite the index now, while the viewer is still watching the
    // spinner, so the actual media request is answered immediately.
    if (plan.mode === 'progressive') {
      await this.faststartLayout(session, index)
    }

    return {
      session,
      torrent,
      file,
      index,
      probe,
      plan,
      complete: file.done,
      prepared,
      duration: probe?.duration ?? 0,
      sync,
      subtitle,
      fullLoad,
      quotaLimited,
      // A live remux/transcode stream has no index, so the bar stays dead until we
      // serve a Range-capable file (native containers, or the faststart MP4).
      seekable: Boolean(prepared) || plan.mode === 'direct' || plan.mode === 'progressive',
      inputPath: file.done ? this.diskPath(torrent, file) : null
    }
  }

  /** Explicitly download the entire selected file (opt-in, quota-checked). */
  async ensureFull (id, fileIndex) {
    const session = this.get(id)
    const torrent = session.torrent
    const index = Number(fileIndex)
    const file = torrent.files[index]
    if (!file) throw new HttpError(400, 'Unknown file index.')

    const needed = Math.max(0, file.length - file.downloaded)
    const quota = await this.enforceLimit({ protect: torrent.infoHash, neededBytes: needed })
    if (!quota.ok) {
      throw new HttpError(507, `Not enough room under the ${formatBytes(quota.limitBytes)} limit. Delete something from the library first.`, { quota })
    }

    file.select()
    session.selectedFileIndex = index
    session.lastActionAt = Date.now()
    return file
  }

  /* --------------------------------------------------------------- prepare -- */

  async preparedInfo (infoHash, fileIndex) {
    const outputPath = preparedFilePath({ dataDir: this.dataDir, infoHash, fileIndex })
    const stat = await statOrNull(outputPath)
    return stat ? { path: outputPath, size: stat.size, fileIndex, ready: true } : null
  }

  /**
   * Convert a fully downloaded file into a seekable faststart MP4 so it can be
   * scrubbed - the live streaming paths cannot seek by nature.
   */
  async prepare (id, fileIndex, { budgetMs = 0, preset = null, attempt = 1 } = {}) {
    if (!this.seekableCopyEnabled) {
      throw new HttpError(403, 'Seekable-copy conversion is disabled (native on-demand playback). Set ENABLE_SEEKABLE_COPY=1 to enable it.')
    }
    const session = this.get(id)
    const torrent = session.torrent
    const index = Number(fileIndex)
    const file = torrent.files[index]
    if (!file) throw new HttpError(400, 'Unknown file index.')

    const existing = await this.preparedInfo(torrent.infoHash, index)
    if (existing) return { ...existing, progress: 1, state: 'done' }

    if (session.prepare?.state === 'running' && session.prepare.fileIndex === index) return session.prepare

    if (!file.done) {
      throw new HttpError(409, 'The file has to be fully downloaded before a seekable copy can be made.', {
        fileProgress: file.progress,
        downloaded: file.downloaded,
        length: file.length
      })
    }

    // A seekable copy is a second copy of the file on disk - refuse absurd ones
    // outright rather than filling the disk.
    if (file.length > PREPARE_LIMIT_BYTES) {
      throw new HttpError(413, `“${file.name}” is ${formatBytes(file.length)}. Seekable copies are limited to ${formatBytes(PREPARE_LIMIT_BYTES)} (raise MAX_PREPARE_GB to change that).`)
    }

    const probe = await this.probeFor(session, index)
    const plan = planPlayback({ fileName: file.name, probe, hevcSupported: false })
    if (plan.mode === 'direct') throw new HttpError(400, 'This file already plays natively and seeks on its own.')

    const estimated = plan.videoCopy ? file.length : Math.round(file.length * 0.8)
    const quota = await this.enforceLimit({ protect: torrent.infoHash, neededBytes: estimated })
    if (!quota.ok) {
      throw new HttpError(507, `A seekable copy needs about ${formatBytes(estimated)} more and the limit is ${formatBytes(quota.limitBytes)}. Delete something first.`, { quota })
    }

    // A re-encode is a full pass over the film, so default it to the fast preset:
    // measured on a 1080p HEVC feature that is ~41 min instead of ~75. A remux
    // copies the streams and takes seconds either way, so it keeps the better
    // preset. PREPARE_PRESET overrides both.
    const preparePreset = preset ?? (plan.videoCopy ? null : 'ultrafast')

    // Keep the copy in the same size league as the source.
    //
    // Without this, a fast preset produced a file 3.3x larger than the film it came
    // from (7.2 GB from 2.2 GB) - enough to blow through a storage cap on its own.
    // CRF 22 with a loose ceiling (2.5x the source rate) lands at roughly the
    // source's own size while leaving quality to the encoder.
    const sourceBps = probe?.duration ? (file.length * 8) / probe.duration : 0
    const maxBitrateKbps = plan.videoCopy ? 0 : Math.max(800, Math.round((sourceBps * 2.5) / 1000))
    const prepareCrf = plan.videoCopy ? 21 : 22

    const outputPath = preparedFilePath({ dataDir: this.dataDir, infoHash: torrent.infoHash, fileIndex: index })
    session.prepare = {
      fileIndex: index,
      state: 'running',
      progress: 0,
      etaMs: null,
      videoCopy: plan.videoCopy,
      audioCopy: plan.audioCopy,
      error: null
    }

    // Watch the first stretch of a re-encode and extrapolate. If the whole film
    // would take longer than the budget, stop rather than grind for hours.
    if (budgetMs > 0 && !plan.videoCopy && probe?.duration) {
      const startedAt = Date.now()
      const watchdog = setInterval(() => {
        const progress = session.prepare?.progress ?? 0
        const elapsed = Date.now() - startedAt
        if (progress <= 0.001 || elapsed < 12000) return
        const totalMs = elapsed / progress
        if (session.prepare) session.prepare.etaMs = Math.round(totalMs - elapsed)
        if (totalMs > budgetMs) {
          clearInterval(watchdog)
          session.prepareHandle?.kill()
          const minutes = Math.round(totalMs / 60000)

          // Before giving up, retry once with the fastest preset. Measured on a
          // 1080p HEVC film that is ~1.8x quicker (75 min -> 41 min), which is
          // often the difference between "too slow" and "worth doing".
          const canGoFaster = attempt === 1 && !plan.videoCopy && preparePreset !== 'ultrafast'
          if (canGoFaster) {
            this.log(`[prepare] ${minutes} min is over budget - retrying with the fast preset`)
            // Clear the state first: prepare() returns early when a prepare is
            // already marked running, which made this retry a silent no-op.
            session.prepare = null
            setTimeout(() => {
              this.prepare(id, index, { budgetMs, preset: 'ultrafast', attempt: 2 })
                .catch(err => this.log(`[prepare] fast retry failed: ${err.message}`))
            }, 250)
            return
          }

          session.prepare = {
            fileIndex: index,
            state: 'failed',
            progress: 0,
            error: `stopped: this conversion would take about ${minutes} minutes (budget ${Math.round(budgetMs / 60000)}). Playback still works via live conversion.`
          }
          this.log(`[prepare] aborted - estimated ${minutes} min exceeds the budget`)
        }
      }, 4000)
      watchdog.unref?.()
      session.prepareWatchdog = watchdog
    }

    session.prepareHandle = startPrepare({
      inputPath: this.diskPath(torrent, file),
      outputPath,
      plan,
      preset: preparePreset,
      maxBitrateKbps,
      crf: prepareCrf,
      duration: probe?.duration ?? 0,
      log: this.log,
      onProgress: fraction => {
        if (session.prepare) session.prepare.progress = fraction
      },
      onDone: ({ size }) => {
        clearInterval(session.prepareWatchdog)
        session.prepare = { fileIndex: index, state: 'done', progress: 1, size, error: null }
        session.prepareHandle = null
        this.usage.invalidate()
        this.library.patch(torrent.infoHash, { prepared: { fileIndex: index, size } })
          .catch(err => this.log(`[library] ${err.message}`))
        this.log(`[prepare] seekable copy ready (${formatBytes(size)})`)
      },
      onFail: message => {
        clearInterval(session.prepareWatchdog)
        session.prepare = { fileIndex: index, state: 'failed', progress: 0, error: message }
        session.prepareHandle = null
        this.log(`[prepare] failed: ${message}`)
      }
    })

    return session.prepare
  }

  /* --------------------------------------------------------------- sync -- */

  /**
   * A/V delay is remembered per file, not per torrent: in a split-scene release
   * each scene can be authored with a different offset, so one global value would
   * fix one scene and break the rest.
   */
  async savedSync (infoHash, fileIndex) {
    const meta = await this.library.read(infoHash)
    const value = Number(meta?.sync?.[fileIndex])
    return Number.isFinite(value) ? value : 0
  }

  async saveSync (infoHash, fileIndex, delayMs) {
    const meta = await this.library.read(infoHash)
    if (!meta) return null
    // Only remember delays for files that actually exist.
    const file = this.sessions.get(infoHash)?.torrent?.files?.[Number(fileIndex)]
    if (!file) throw new HttpError(400, 'Unknown file index.')
    const sync = { ...(meta.sync ?? {}), [String(fileIndex)]: Math.round(Number(delayMs) || 0) }
    await this.library.patch(infoHash, { sync })
    return sync
  }

  /* ------------------------------------------------------------ subtitles -- */

  /**
   * Subtitle selection + timing are remembered per video file, like the A/V
   * delay. `subSel[fileIndex]` is the last track id (null = explicitly Off);
   * `subSync[fileIndex][trackId]` is that track's { offsetMs, scale }.
   */
  async savedSubtitlePrefs (infoHash, fileIndex) {
    const meta = await this.library.read(infoHash)
    const sel = meta?.subSel?.[String(fileIndex)]
    const syncs = meta?.subSync?.[String(fileIndex)] ?? {}
    return { trackId: sel === undefined ? undefined : sel, syncs }
  }

  async saveSubSelection (infoHash, fileIndex, trackId) {
    const meta = await this.library.read(infoHash)
    if (!meta) return null
    const subSel = { ...(meta.subSel ?? {}), [String(fileIndex)]: trackId ?? null }
    await this.library.patch(infoHash, { subSel })
    return subSel
  }

  async saveSubSync (infoHash, fileIndex, trackId, { offsetMs = 0, scale = 1 } = {}) {
    if (!trackId) throw new HttpError(400, 'A subtitle track id is required.')
    const meta = await this.library.read(infoHash)
    if (!meta) return null
    const offset = Math.max(-60000, Math.min(60000, Math.round(Number(offsetMs) || 0)))
    let factor = Number(scale) || 1
    if (!Number.isFinite(factor) || factor <= 0 || factor < 0.9 || factor > 1.1) factor = 1
    const perFile = { ...(meta.subSync?.[String(fileIndex)] ?? {}) }
    perFile[String(trackId)] = { offsetMs: offset, scale: factor }
    await this.library.patch(infoHash, { subSync: { ...(meta.subSync ?? {}), [String(fileIndex)]: perFile } })
    return perFile
  }

  /**
   * Everything the player can offer for this file: tracks already inside it,
   * sidecars bundled in the torrent, downloaded from OpenSubtitles earlier,
   * and whether the provider is usable.
   */
  async subtitleTracks (session, fileIndex) {
    const index = Number(fileIndex)
    const probe = session.probes.get(index)
    const embedded = (probe?.subtitles ?? []).map(track => ({
      kind: 'embedded',
      id: `embedded-${track.streamIndex}`,
      streamIndex: track.streamIndex,
      language: normalizeLang(track.language) ?? track.language,
      label: track.title || track.language || track.codec,
      codec: track.codec,
      forced: track.forced,
      default: track.default,
      // Bitmap tracks (PGS/VobSub) cannot become WebVTT without OCR.
      playable: track.text
    }))
    // Subtitles that ship in the torrent itself (a `Subs/English.srt` next to
    // the video) are the best timing match possible — same release, same cut —
    // so they are offered before any downloaded track.
    const bundled = session.torrent.files
      .map((file, fileIndex) => ({ file, fileIndex }))
      .filter(({ file }) => isSubtitleFile(file.name) && file.length > 0)
      .map(({ file, fileIndex }) => ({
        kind: 'bundled',
        id: `bundled-${fileIndex}`,
        fileIndex,
        language: guessLanguageFromName(file.name),
        label: path.basename(String(file.path || file.name)),
        size: file.length,
        playable: true
      }))
    const external = await this.subtitles.list(session.id, index)
    const key = openSubtitlesKey()
    const saved = await this.savedSubtitlePrefs(session.id, index)
    return {
      embedded,
      bundled,
      external,
      // `trackId: undefined` means "never chosen" (auto-pick may apply);
      // `null` means the user explicitly turned subtitles off.
      selected: saved.trackId === undefined ? null : saved.trackId,
      neverChosen: saved.trackId === undefined,
      syncs: saved.syncs,
      provider: {
        name: 'OpenSubtitles',
        configured: Boolean(key),
        hint: key ? null : 'Set OPENSUBTITLES_API_KEY to search and download subtitles.'
      }
    }
  }

  bundledTrack (session, trackId) {
    const fileIndex = Number(String(trackId).replace(/^bundled-/, ''))
    const file = session.torrent.files[fileIndex]
    if (!file || !isSubtitleFile(file.name)) throw new HttpError(404, 'That subtitle track does not exist.')
    return { fileIndex, file }
  }

  /** Convert a torrent-bundled sidecar to WebVTT (cached on first use). */
  async extractBundledSubtitle (session, sidecarFileIndex) {
    const file = session.torrent.files[Number(sidecarFileIndex)]
    if (!file || !isSubtitleFile(file.name)) throw new HttpError(404, 'That subtitle track does not exist.')
    const infoHash = session.id
    const cachePath = path.join(this.subtitles.infoHashDir(infoHash), `bundled-${fileIndexSafe(sidecarFileIndex)}.vtt`)
    const existing = await statOrNull(cachePath)
    if (existing) return { path: cachePath, cached: true }

    // Sidecars are small, so reading the whole file is cheap. Prefer the disk
    // once downloaded; otherwise pull it through the torrent store.
    let buffer
    if (file.done) {
      buffer = await fs.readFile(this.diskPath(session.torrent, file))
    } else {
      if (!await this.waitReady(session.torrent)) throw new HttpError(503, 'Torrent is not ready yet.')
      const chunks = []
      let size = 0
      const stream = file.createReadStream({ start: 0, end: file.length - 1 })
      try {
        for await (const chunk of stream) {
          chunks.push(chunk)
          size += chunk.length
          if (size >= file.length) break
        }
      } finally {
        stream.destroy()
      }
      buffer = Buffer.concat(chunks, size)
    }

    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    const ext = extensionOf(file.name)
    if (ext === 'srt') {
      const text = srtToVtt(buffer.toString('utf8'))
      if (!/\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\s+-->/.test(text)) throw new Error('That subtitle file has no cues.')
      await fs.writeFile(`${cachePath}.part`, text)
      await fs.rename(`${cachePath}.part`, cachePath)
    } else if (ext === 'vtt') {
      const text = buffer.toString('utf8').replace(/^\uFEFF/, '')
      if (!text.startsWith('WEBVTT')) throw new Error('That subtitle file is not valid WebVTT.')
      await fs.writeFile(`${cachePath}.part`, text)
      await fs.rename(`${cachePath}.part`, cachePath)
    } else {
      const raw = path.join(this.subtitles.infoHashDir(infoHash), `${fileIndexSafe(sidecarFileIndex)}-raw-${Date.now()}`)
      await fs.writeFile(raw, buffer)
      try {
        await convertToVtt({ inputPath: raw, outputPath: cachePath })
      } finally {
        await fs.rm(raw, { force: true }).catch(() => {})
      }
    }
    this.log(`[subs] converted bundled ${file.name} to WebVTT`)
    return { path: cachePath, cached: false }
  }

  /** Extract an embedded track to WebVTT (cached on disk after the first time). */
  async extractEmbeddedSubtitle (session, fileIndex, streamIndex) {
    const index = Number(fileIndex)
    const file = session.torrent.files[index]
    if (!file) throw new HttpError(400, 'Unknown file index.')

    const probe = await this.probeFor(session, index)
    const track = (probe?.subtitles ?? []).find(t => t.streamIndex === Number(streamIndex))
    if (!track) throw new HttpError(404, 'That subtitle track does not exist.')
    if (!track.text) {
      throw new HttpError(415, `This track is ${track.codec} (bitmap subtitles), which cannot be converted to text.`)
    }

    const language = track.language || 'xx'
    const label = `embedded-${streamIndex}`
    const target = this.subtitles.targetPath(session.id, index, language, label)
    const existing = await statOrNull(target)
    if (existing) return { path: target, cached: true, language, label: track.title || language }

    // Read through the range endpoint while the file is incomplete; a local path
    // once it is whole (cheaper, and there are no holes to trip over).
    const input = file.done ? this.diskPath(session.torrent, file) : `${this.rawBase}/raw/${session.id}/${index}`
    await extractSubtitleToVtt({ input, streamIndex: Number(streamIndex), outputPath: target })
    this.log(`[subs] extracted embedded track ${streamIndex} (${track.codec}) for ${file.name}`)
    return { path: target, cached: false, language, label: track.title || language }
  }

  async searchSubtitles (session, fileIndex, { query, languages } = {}) {
    const index = Number(fileIndex)
    const file = session.torrent.files[index]
    if (!file) throw new HttpError(400, 'Unknown file index.')
    if (!openSubtitlesKey()) {
      throw new HttpError(503, 'OpenSubtitles is not configured. Start the server with OPENSUBTITLES_API_KEY=… to enable subtitle search.')
    }
    const term = query || guessTitle(file.name)
    const found = await searchOpenSubtitles({
      query: term,
      languages: Array.isArray(languages) && languages.length ? languages : ['en']
    })
    const results = rankSubtitleResults(found, {
      videoName: file.name,
      language: Array.isArray(languages) && languages.length ? languages[0] : 'en'
    })
    return { query: term, results }
  }

  /** Download one OpenSubtitles result, convert it to WebVTT and keep it. */
  async fetchSubtitle (session, fileIndex, { fileId, language, label } = {}) {
    const index = Number(fileIndex)
    if (!fileId) throw new HttpError(400, 'A subtitle file id is required.')
    if (!openSubtitlesKey()) {
      throw new HttpError(503, 'OpenSubtitles is not configured. Start the server with OPENSUBTITLES_API_KEY=… to enable subtitle downloads.')
    }

    // OpenSubtitles allows only a limited number of downloads per day, so a track
    // that is already on disk is reused instead of fetched again.
    const cached = await this.subtitles.findByFileId(session.id, index, fileId)
    if (cached) {
      return { id: cached.id, language: cached.language, label: cached.label, cached: true }
    }

    const { buffer, fileName } = await downloadOpenSubtitle({ fileId })

    const target = this.subtitles.targetPath(session.id, index, normalizeLang(language) || 'xx', label || fileName, fileId)
    const raw = path.join(this.subtitles.infoHashDir(session.id), `${index}-raw-${Date.now()}`)
    await fs.mkdir(path.dirname(raw), { recursive: true })
    await fs.writeFile(raw, buffer)
    try {
      await convertToVtt({ inputPath: raw, outputPath: target })
    } finally {
      await fs.rm(raw, { force: true }).catch(() => {})
    }
    await this.subtitles.remember(session.id, index, fileId, {
      id: path.basename(target), language: language || null, label: label || fileName
    })
    this.log(`[subs] saved ${fileName} as ${path.basename(target)}`)
    return { id: path.basename(target), language: language || null, label: label || fileName }
  }

  async removeSubtitle (session, fileIndex, id) {
    await this.subtitles.remove(session.id, id)
    return { removed: id }
  }

  /* ---------------------------------------------------------------- status -- */

  /**
   * Called from the progress tick.
   *
   * When a full download reaches 100% we immediately build the faststart MP4, so
   * the player can upgrade itself from a dead seek bar to a real one without the
   * user having to press anything.
   */
  async autoUpgrade (session) {
    const torrent = session.torrent
    let index = session.selectedFileIndex
    if (index === null) {
      index = torrent.files.findIndex(f => isVideoFile(f.name))
    }
    if (index < 0 || session.autoPrepareRan) return
    const file = torrent.files[index]
    if (!file?.done) return

    session.autoPrepareRan = true
    const probe = await this.probeFor(session, index)
    const plan = planPlayback({ fileName: file.name, probe, hevcSupported: true })
    if (plan.mode === 'direct' || plan.mode === 'progressive') return // already seekable

    // A live conversion makes Chrome treat playback as a live stream, which it
    // buffers very conservatively - that is the "buffering..." that appears even
    // when the file is 100% downloaded and the encoder is 30x realtime. Building
    // the seekable copy once removes that entirely.
    //
    // A re-encode is a full pass over the film, so it is only started when the
    // measured rate says it will finish in a reasonable time; otherwise it would
    // silently burn the CPU for hours.
    try {
      await this.prepare(torrent.infoHash, index, { budgetMs: Number(process.env.PREPARE_BUDGET_MS || 43200000) })
    } catch (err) {
      this.log(`[prepare] skipped: ${err.message}`)
    }
  }

  status (session) {
    const torrent = session.torrent
    const file = session.selectedFileIndex === null ? null : torrent.files[session.selectedFileIndex]
    return {
      id: torrent.infoHash,
      name: torrent.name,
      ready: torrent.ready,
      destroyed: torrent.destroyed,
      progress: torrent.progress,
      downloaded: torrent.downloaded,
      uploaded: torrent.uploaded ?? 0,
      length: torrent.length,
      downloadSpeed: torrent.downloadSpeed ?? 0,
      uploadSpeed: torrent.uploadSpeed ?? 0,
      peers: torrent.numPeers ?? 0,
      timeRemaining: Number.isFinite(torrent.timeRemaining) ? torrent.timeRemaining : null,
      path: torrent.path,
      selected: session.selectedFileIndex,
      quotaBlocked: session.quotaBlocked,
      fullLoad: Boolean(session.fullLoad),
      paused: Boolean(session.paused),
      playhead: session.playhead || 0,
      streams: session.activeStreams.size,
      selections: torrent._selections?.length ?? 0,
      buffering: {
        aheadSeconds: session.paused ? BUFFER_AHEAD_PAUSED_S : BUFFER_AHEAD_S,
        playhead: Math.round(session.playhead || 0)
      },
      duration: session.probes.get(session.selectedFileIndex)?.duration ?? 0,
      // How far into the movie playback can currently reach, in seconds.
      playable: file
        ? this.playableSeconds(torrent, file, session.probes.get(session.selectedFileIndex)?.duration ?? 0)
        : 0,
      prepared: session.prepare?.state === 'done'
        ? { fileIndex: session.prepare.fileIndex, size: session.prepare.size ?? 0 }
        : null,
      file: file
        ? {
            index: session.selectedFileIndex,
            name: file.name,
            length: file.length,
            downloaded: file.downloaded,
            progress: file.progress,
            done: file.done,
            path: this.diskPath(torrent, file)
          }
        : null,
      prepare: session.prepare
    }
  }

  statuses () {
    return [...this.sessions.values()].map(session => this.status(session))
  }

  /* ------------------------------------------------------------- lifecycle -- */

  /**
   * Keep ./data under its ceiling.
   *
   * Deletes the oldest library items first (never the one being watched), and
   * reports whether there is room for `neededBytes` afterwards. Nothing here
   * touches the app folder itself - only torrent payloads and prepared copies.
   */
  async enforceLimit ({ protect = null, neededBytes = 0 } = {}) {
    let { bytes, limitBytes } = await this.usage.usage()
    if (bytes + neededBytes <= limitBytes) return { ok: true, freed: 0, bytes, limitBytes }

    const items = await this.library.list()
    let freed = 0
    for (const item of items) {
      if (item.infoHash === protect) continue
      const active = this.sessions.get(item.infoHash)
      if (active && Date.now() - active.lastActionAt < 5 * 60 * 1000) continue // busy: not a candidate
      freed += await this.deleteData(item.infoHash, { keepMeta: true })
      this.usage.invalidate()
      bytes = await this.usage.measure()
      if (bytes + neededBytes <= limitBytes) break
    }

    const ok = bytes + neededBytes <= limitBytes
    if (freed) this.log(`[storage] evicted ${formatBytes(freed)} to stay under the limit`)
    return { ok, freed, bytes, limitBytes }
  }

  /** Delete a torrent's payload (and any prepared copy). Keeps library metadata by default. */
  async deleteData (infoHash, { keepMeta = true } = {}) {
    const session = this.sessions.get(infoHash)
    let freed = 0

    if (session && !session.torrent.destroyed) {
      session.prefetcher.stop()
      session.prepareHandle?.kill()
      freed = await deleteTorrentData(session.torrent, { log: this.log })
      this.sessions.delete(infoHash)
    } else {
      const meta = await this.library.read(infoHash)
      if (meta) freed = await removeFiles(this.dataDir, meta.files)
    }

    await fs.rm(preparedDir({ dataDir: this.dataDir, infoHash }), { recursive: true, force: true }).catch(() => {})
    if (!keepMeta) await this.library.forget(infoHash)
    this.usage.invalidate()
    this.log(`[storage] deleted ${formatBytes(freed)} for ${infoHash.slice(0, 8)}`)
    return freed
  }

  /** Detach a torrent without deleting anything (data stays playable offline). */
  async close (infoHash) {
    const session = this.sessions.get(infoHash)
    if (!session || session.torrent.destroyed) return false
    session.prefetcher.stop()
    session.prepareHandle?.kill()
    await new Promise(resolve => session.torrent.destroy(() => resolve()))
    this.sessions.delete(infoHash)
    return true
  }

  /** Release sessions nobody is watching, so idle torrents stop using peers. */
  async reapIdleSessions () {
    const now = Date.now()
    for (const [infoHash, session] of this.sessions) {
      if (now - session.lastActionAt < IDLE_SESSION_MS) continue
      this.log(`[session] releasing idle torrent ${infoHash.slice(0, 8)}`)
      await this.close(infoHash)
    }
  }

  async destroy () {
    await new Promise(resolve => this.client.destroy(() => resolve()))
  }
}

export function formatBytes (bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function fileIndexSafe (value) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : 0
}
