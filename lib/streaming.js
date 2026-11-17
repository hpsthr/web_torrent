import fs from 'node:fs'
import { Readable } from 'node:stream'
import { streamArgs, fileStreamArgs, urlStreamArgs, spawnFfmpeg } from './ffmpeg.js'

const WINDOW_BYTES = Math.max(4, Number(process.env.WINDOW_MB || 32)) * 1024 * 1024
const CRITICAL_WINDOW_BYTES = Math.max(4, Number(process.env.PREFETCH_WINDOW_MB || 48)) * 1024 * 1024
const FIRST_BYTE_TIMEOUT_MS = Number(process.env.FFMPEG_FIRST_BYTE_TIMEOUT_MS || 45000)

/**
 * Keeps a rolling priority window on the pieces the player is about to need.
 *
 * WebTorrent only requests pieces that fall inside a *selection*, and `critical`
 * decides how urgently those requests are made (a critical piece is requested
 * even when the peer is otherwise choked). Marking a window ahead of the read
 * head keeps the swarm working on the bytes that matter instead of letting the
 * connection pool idle between windows.
 */
export class HeadPrefetcher {
  constructor (torrent, { windowBytes = CRITICAL_WINDOW_BYTES } = {}) {
    this.torrent = torrent
    this.windowPieces = Math.max(4, Math.ceil(windowBytes / torrent.pieceLength))
    this.bytes = 0
    // Byte offset of the file being played *inside the torrent*. Piece indices are
    // torrent-wide, so without this a file that does not start at 0 would mark the
    // wrong pieces as critical - starving the file that is actually playing.
    this.fileOffset = 0
    this._timer = null
  }

  /** Point the window at a specific file in the torrent. */
  useFile (file) {
    this.fileOffset = file?.offset ?? 0
    return this
  }

  seek (byteOffset) {
    this.bytes = Math.max(0, Number(byteOffset) || 0)
    this.tick()
  }

  advance (delta) {
    this.bytes += delta
    this.tick()
  }

  start () {
    if (this._timer) return
    this._timer = setInterval(() => this.tick(), 2000)
    this._timer.unref?.()
  }

  stop () {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
  }

  tick () {
    const torrent = this.torrent
    if (!torrent || torrent.destroyed || !torrent.ready || !torrent.pieceLength) return
    const lastPiece = torrent.pieces.length - 1
    const torrentByte = this.fileOffset + this.bytes
    const head = Math.min(Math.max(0, Math.floor(torrentByte / torrent.pieceLength)), lastPiece)
    const tail = Math.min(head + this.windowPieces, lastPiece)
    torrent.critical(head, tail)
  }
}

/**
 * Read a torrent file in bounded, sequential windows.
 *
 * Why not one long `file.createReadStream()`? Because a read stream registers a
 * selection covering its whole range, and WebTorrent downloads every selected
 * piece - so a single stream over a 4 GB file quietly downloads all 4 GB. Reading
 * in windows keeps the selected range small (this window plus one window of read
 * ahead) while still delivering a continuous byte stream, so disk usage tracks
 * what is actually watched instead of the size of the torrent.
 *
 * Sequential in-order download comes from WebTorrent's default 'sequential'
 * strategy, and each window's selection is released when its stream is destroyed.
 */
export function createTorrentReadStream ({ file, start = 0, end, windowBytes = WINDOW_BYTES, onBytes }) {
  const total = file.length
  const finish = end === undefined ? total - 1 : Math.min(end, total - 1)
  const first = Math.max(0, Math.min(start, total - 1))
  const size = Math.max(1, Math.min(windowBytes, total))

  async function * windows () {
    let position = first
    let pending = null
    try {
      while (position <= finish) {
        const windowEnd = Math.min(position + size - 1, finish)
        const stream = pending ?? file.createReadStream({ start: position, end: windowEnd })
        pending = null

        // Open (but do not consume) the next window now: its selection is
        // registered immediately, so the swarm fetches ahead while we drain this
        // one. Pieces land in the on-disk store, not in memory.
        const nextPosition = windowEnd + 1
        if (nextPosition <= finish) {
          pending = file.createReadStream({
            start: nextPosition,
            end: Math.min(nextPosition + size - 1, finish)
          })
        }

        try {
          for await (const chunk of stream) {
            onBytes?.(chunk.length)
            yield chunk
          }
        } finally {
          stream.destroy()
        }

        position = nextPosition
      }
    } finally {
      pending?.destroy()
    }
  }

  // Byte mode (not object mode) so backpressure is measured in bytes, and a small
  // high-water mark keeps at most a few pieces buffered in memory.
  return Readable.from(windows(), { objectMode: false, highWaterMark: 1 << 16 })
}

/** Parse a single-range `Range: bytes=...` header against a known size. */
export function parseRange (header, size) {
  if (!header || !size) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null

  let start
  let end
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > end || start >= size) return null
  return { start, end }
}

/**
 * Serve raw torrent bytes with HTTP Range support.
 *
 * This is the zero-CPU path: the browser demuxes MP4/MOV/WebM itself and seeks
 * by issuing new range requests, while we only pull the bytes it asks for.
 */
export function streamFileToResponse ({ req, res, file, contentType, prefetcher }) {
  const size = file.length
  const range = parseRange(req.headers.range, size)
  const start = range ? range.start : 0
  const end = range ? range.end : size - 1

  const headers = {
    'Content-Type': contentType,
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  }
  // Content-Range is mandatory on a 206. Without it a client cannot tell where
  // the body begins and silently assumes offset 0 - which makes ffmpeg report
  // "Unexpected offset" and abandon the seek, and is what broke seeking entirely.
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`

  res.writeHead(range ? 206 : 200, headers)

  prefetcher?.useFile(file)
  prefetcher?.seek(start)

  const stream = createTorrentReadStream({
    file,
    start,
    end,
    onBytes: length => prefetcher?.advance(length)
  })

  let done = false
  const teardown = () => {
    if (done) return
    done = true
    stream.destroy()
  }
  req.on('close', teardown)
  res.on('close', teardown)
  stream.on('error', err => {
    if (!res.writableEnded) res.destroy(err)
  })
  stream.pipe(res)

  return { start, end }
}

/**
 * Wait for ffmpeg's first output chunk, keeping everything received so far.
 *
 * Headers are deliberately withheld until this resolves: a pipeline that cannot
 * produce a single frame (unsupported input, no peers, ffmpeg missing) must still
 * surface as a clean HTTP error, which the player turns into a strategy switch
 * instead of an endless spinner.
 */
function awaitFirstOutput (proc, timeoutMs) {
  return new Promise(resolve => {
    const buffered = []
    let settled = false
    let timer = null

    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.stdout.off('data', onData)
      proc.stdout.pause() // keeps the remainder buffered in the stream; nothing is lost
      proc.off('exit', onExit)
      proc.off('error', onError)
      resolve({ ...result, buffered })
    }

    const onData = chunk => {
      buffered.push(chunk)
      finish({ ok: true })
    }
    const onExit = code => finish({ ok: false, reason: `ffmpeg exited with code ${code}` })
    const onError = err => finish({ ok: false, reason: `ffmpeg could not start: ${err.message}` })

    timer = setTimeout(() => finish({ ok: false, reason: 'timed out waiting for the first frame' }), timeoutMs)
    proc.stdout.on('data', onData)
    proc.on('exit', onExit)
    proc.on('error', onError)
  })
}

/**
 * Transcode/remux a torrent file into a live fragmented MP4 response.
 *
 * `inputPath` set  -> read the finished file from disk (seekable input).
 * `inputPath` null -> read the torrent stream itself, so playback starts after a
 *                     few hundred KB instead of after the whole download.
 */
export async function streamTranscodedToResponse ({ req, res, file, plan, prefetcher, inputPath, inputUrl, windowBytes, startAt = 0, audioStreamIndex = null, audioDelayMs = 0 }) {
  const args = inputUrl
    ? urlStreamArgs({ inputUrl, videoCopy: plan.videoCopy, audioCopy: plan.audioCopy, startAt, audioStreamIndex, audioDelayMs })
    : inputPath
      ? fileStreamArgs({ inputPath, videoCopy: plan.videoCopy, audioCopy: plan.audioCopy, startAt, audioStreamIndex, audioDelayMs })
      : streamArgs({ videoCopy: plan.videoCopy, audioCopy: plan.audioCopy, startAt, audioStreamIndex, audioDelayMs })

  const { proc, getStderr, kill } = spawnFfmpeg(args)

  let source = null
  if (!inputPath && !inputUrl) {
    prefetcher?.useFile(file)
    source = createTorrentReadStream({
      file,
      start: 0,
      windowBytes,
      onBytes: length => prefetcher?.advance(length)
    })
    prefetcher?.seek(0)
    source.on('error', err => proc.stdin.destroy(err))
    proc.stdin.on('error', () => {}) // EPIPE when ffmpeg exits first; not fatal
    source.pipe(proc.stdin)
  }

  let torn = false
  const teardown = () => {
    if (torn) return
    torn = true
    kill()
    source?.destroy()
  }
  req.on('close', teardown)
  res.on('close', teardown)

  const first = await awaitFirstOutput(proc, FIRST_BYTE_TIMEOUT_MS)
  if (!first.ok) {
    teardown()
    const stderr = getStderr()
    const error = new Error(stderr || first.reason)
    error.code = 'PIPELINE_FAILED'
    error.detail = first.reason
    error.stderr = stderr
    throw error
  }
  if (torn) return // client vanished while we waited

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no'
  })
  for (const chunk of first.buffered) res.write(chunk)
  proc.stdout.pipe(res)
}

/**
 * Serve a repaired MP4 (index relocated to the front) as an ordinary file.
 *
 * Virtual layout is `[ftyp][moov][mdat]`. Bytes inside the header come from memory;
 * everything past it maps straight onto the torrent's mdat, so a seek turns into a
 * Range request that fetches exactly those pieces. The browser sees a normal
 * faststart MP4, which means it starts playing immediately and can scrub freely.
 */
export function streamFaststartToResponse ({ req, res, file, layout, prefetcher }) {
  const headerLength = layout.header.length
  const total = headerLength + layout.mdatLength
  const range = parseRange(req.headers.range, total)
  const start = range ? range.start : 0
  const end = range ? range.end : total - 1

  const headers = {
    'Content-Type': 'video/mp4',
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${total}`
  res.writeHead(range ? 206 : 200, headers)

  let cursor = start

  // 1. any part of the request that lands in the rebuilt header
  if (cursor < headerLength) {
    const headerEnd = Math.min(end, headerLength - 1)
    res.write(layout.header.subarray(cursor, headerEnd + 1))
    cursor = headerEnd + 1
  }

  // 2. the rest maps onto the real mdat
  if (cursor <= end) {
    const from = layout.mdatOffset + (cursor - headerLength)
    const to = layout.mdatOffset + (end - headerLength)
    prefetcher?.useFile(file)
    prefetcher?.seek(from)
    const stream = createTorrentReadStream({
      file,
      start: from,
      end: to,
      onBytes: length => prefetcher?.advance(length)
    })
    let done = false
    const teardown = () => {
      if (done) return
      done = true
      stream.destroy()
    }
    req.on('close', teardown)
    res.on('close', teardown)
    stream.on('error', err => {
      if (!res.writableEnded) res.destroy(err)
    })
    stream.pipe(res)
  } else {
    res.end()
  }

  return { start, end, total }
}

/**
 * Serve a finished, faststart MP4 from disk with full Range support.
 *
 * This is what the "make seekable" step produces: after a one-off conversion the
 * file seeks like any normal video and needs no ffmpeg or peers at all.
 */
export function streamPreparedToResponse ({ req, res, filePath, size }) {
  const file = {
    length: size,
    createReadStream: ({ start = 0, end } = {}) =>
      fs.createReadStream(filePath, end === undefined ? { start } : { start, end })
  }
  return streamFileToResponse({ req, res, file, contentType: 'video/mp4' })
}
