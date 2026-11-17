import './lib/env.js' // MUST be first: redirects TMPDIR before webtorrent is loaded
import { appendLog, logError, installCrashLogging } from './lib/log.js'

installCrashLogging()

import express from 'express'
import path from 'node:path'
import fs from 'node:fs/promises'
import { DATA_DIR, PATHS, PORT, HOST, PUBLIC_DIR, STORAGE_LIMIT_BYTES, PREPARE_LIMIT_BYTES } from './lib/env.js'
import { TorrentManager, formatBytes } from './lib/torrents.js'
import { planPlayback, mimeOf } from './lib/media.js'
import { toolchain } from './lib/probe.js'
import { execSync } from 'node:child_process'
import { streamFileToResponse, streamTranscodedToResponse, streamPreparedToResponse, streamFaststartToResponse } from './lib/streaming.js'
import { shiftVttTimestamps } from './lib/subtitles.js'

const log = (...args) => {
  console.log(new Date().toISOString().slice(11, 19), ...args)
  appendLog(args)
}

const manager = new TorrentManager({
  dataDir: DATA_DIR,
  limitBytes: STORAGE_LIMIT_BYTES,
  log,
  // Lets ffprobe read a torrent file over the range endpoint and seek inside it,
  // which is how a trailing moov atom (non-faststart MP4) is found.
  rawBase: `http://127.0.0.1:${PORT}`
})
const app = express()

app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))
app.use((req, res, next) => {
  if (!req.path.startsWith('/stream/')) {
    res.on('finish', () => {
      if (req.path.startsWith('/api/')) log(`${req.method} ${req.path} -> ${res.statusCode}`)
    })
  }
  next()
})

/* ----------------------------------------------------------------- health -- */

app.get('/api/health', async (req, res, next) => {
  try {
    const tools = await toolchain()
    const usage = await manager.usage.measure()
    res.json({
      ok: true,
      ffmpeg: tools,
      paths: PATHS,
      limits: {
        storageBytes: STORAGE_LIMIT_BYTES,
        prepareBytes: PREPARE_LIMIT_BYTES,
        storageLabel: formatBytes(STORAGE_LIMIT_BYTES)
      },
      usage: { bytes: usage, limitBytes: STORAGE_LIMIT_BYTES },
      active: manager.statuses().length
    })
  } catch (err) {
    next(err)
  }
})

app.get('/api/storage', async (req, res, next) => {
  try {
    const bytes = await manager.usage.measure()
    res.json({ bytes, limitBytes: STORAGE_LIMIT_BYTES, ratio: STORAGE_LIMIT_BYTES ? bytes / STORAGE_LIMIT_BYTES : 0 })
  } catch (err) {
    next(err)
  }
})

/* --------------------------------------------------------------- torrents -- */

app.post('/api/torrents', async (req, res, next) => {
  try {
    const session = await manager.add(req.body?.magnet ?? req.body?.source)
    res.json({
      id: session.id,
      name: session.torrent.name,
      infoHash: session.torrent.infoHash,
      length: session.torrent.length,
      files: manager.videoFiles(session.torrent),
      allFileCount: session.torrent.files.length,
      status: manager.status(session)
    })
  } catch (err) {
    next(err)
  }
})

app.get('/api/torrents', (req, res) => {
  res.json({ sessions: manager.statuses() })
})

app.get('/api/torrents/:id', async (req, res, next) => {
  try {
    const session = manager.get(req.params.id)
    session.lastActionAt = Date.now()
    const usage = await manager.usage.usage()
    res.json({ status: manager.status(session), files: manager.videoFiles(session.torrent), usage })
  } catch (err) {
    next(err)
  }
})

app.patch('/api/torrents/:id', async (req, res, next) => {
  try {
    const session = manager.get(req.params.id)
    session.lastActionAt = Date.now()
    const index = req.body?.fileIndex ?? session.selectedFileIndex
    if (index !== undefined && index !== null) {
      const file = session.torrent.files[Number(index)]
      if (!file) throw new HttpError(400, 'Unknown file index.')
      if (session.selectedFileIndex !== Number(index)) {
        session.selectedFileIndex = Number(index)
      }
    }
    res.json({ status: manager.status(session) })
  } catch (err) {
    next(err)
  }
})

app.post('/api/torrents/:id/close', (req, res, next) => {
  try {
    const session = manager.get(req.params.id)
    manager.close(session.id)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

app.delete('/api/torrents/:id', async (req, res, next) => {
  try {
    const session = manager.get(req.params.id)
    await manager.deleteData(session.infoHash ?? session.id, { keepMeta: req.query.keepMeta === 'true' })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

app.get('/api/library', async (req, res, next) => {
  try {
    const items = await manager.library.list()
    res.json({ items, usage: { bytes: await manager.usage.measure(), limitBytes: STORAGE_LIMIT_BYTES } })
  } catch (err) {
    next(err)
  }
})

app.post('/api/library/delete', async (req, res, next) => {
  try {
    const { infoHash } = req.body ?? {}
    if (!infoHash) throw new HttpError(400, 'infoHash is required.')
    await manager.library.remove(infoHash)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

/* ----------------------------------------------------------- selection --- */

app.post('/api/torrents/:id/select', async (req, res, next) => {
  try {
    const session = manager.get(req.params.id)
    const index = Number(req.body?.fileIndex)
    const full = req.body?.full === true
    const keepData = req.body?.keepData
    if (!Number.isInteger(index) || index < 0 || index >= session.torrent.files.length) {
      throw new HttpError(400, 'Unknown file index.')
    }

    // One file at a time: drop the previous file's explicit selection before
    // picking the new one.
    if (session.selectedFileIndex !== null && session.selectedFileIndex !== index) {
      const previous = session.torrent.files[session.selectedFileIndex]
      if (previous && !previous.done) previous.deselect()
    }
    session.selectedFileIndex = index
    if (typeof keepData === 'boolean') session.keepData = keepData
    session.lastActionAt = Date.now()
    session.prefetcher.useFile(session.torrent.files[index])
    session.prefetcher.seek(0)
    session.prefetcher.start()
    if (full) session.torrent.files[index].select()

    res.json({ ok: true, status: manager.status(session) })
  } catch (err) {
    next(err)
  }
})

app.post('/api/torrents/:id/play', async (req, res, next) => {
  try {
    const id = req.params.id
    const index = Number(req.body?.fileIndex ?? req.body?.index ?? 0)
    const full = req.body?.full === true

    const session = manager.get(id)
    const file = session.torrent.files[index]
    if (!file) throw new HttpError(400, 'Unknown file index.')

    const audioCodecs = {}
    if (typeof req.body?.audioCodecs === 'string') {
      for (const c of req.body.audioCodecs.split(',')) {
        if (c) audioCodecs[c] = true
      }
    }
    const result = await manager.play(id, index, { full, hevcSupported: req.body?.hevcSupported === true, audioCodecs })
    const { plan } = result

    let prepare = null
    if (req.body?.prepare !== false) {
      const info = await manager.preparedInfo(id, index)
      if (info) prepare = { url: `/stream/${id}/${index}?mode=prepared`, size: info.size }
    }

    res.json({
      id: result.session.id,
      index,
      name: result.file.name,
      length: result.file.length,
      mime: mimeOf(result.file.name),
      mode: plan.mode,
      videoCopy: plan.videoCopy,
      audioCopy: plan.audioCopy,
      reason: plan.reason,
      probe: result.probe,
      duration: result.duration,
      sync: result.sync ?? 0,
      subtitle: result.subtitle ?? { trackId: undefined, syncs: {} },
      fullLoad: result.fullLoad,
      quotaLimited: result.quotaLimited,
      seekable: result.seekable,
      complete: result.complete,
      prepared: prepare ? { url: `/stream/${result.session.id}/${index}?mode=prepared`, size: prepare.size } : null,
      streamUrl: `/stream/${result.session.id}/${index}?mode=${plan.mode === 'direct' ? 'direct' : 'auto'}`,
      status: manager.status(result.session)
    })
  } catch (err) {
    next(err)
  }
})

/** Opt-in: download the whole selected file (quota-checked). */
app.post('/api/torrents/:id/keep-full', async (req, res, next) => {
  try {
    const session = manager.get(req.params.id)
    const index = Number(req.body?.fileIndex ?? session.selectedFileIndex)
    const sessionId = session.id
    await manager.ensureFull(session.id, index)
    res.json({ ok: true, status: manager.status(manager.get(session.id)) })
  } catch (err) {
    next(err)
  }
})

app.post('/api/torrents/:id/pause', (req, res) => {
  const session = manager.sessions.get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Unknown torrent.' })
  session.paused = true
  for (const s of session.torrent.files) s.deselect()
  manager.stopStreams(session)
  res.json({ ok: true, paused: true, streams: session.activeStreams.size })
})

app.post('/api/torrents/:id/resume', (req, res) => {
  const session = manager.sessions.get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Unknown torrent.' })
  session.paused = false
  const index = session.selectedFileIndex ?? 0
  const file = session.torrent.files[index]
  if (file) {
    file.select()
    session.selected = true
  }
  res.json({ ok: true, paused: false, streams: session.activeStreams.size })
})

app.post('/api/torrents/:id/playhead', async (req, res, next) => {
  try {
    const session = manager.get(req.params.id)
    const target = Math.max(0, Number(req.body?.position) || 0)
    const duration = Number(req.body?.duration) || 0
    const fileIndex = Number(req.body?.fileIndex ?? session.selectedFileIndex ?? 0)
    await manager.library.patch(session.id, {
      resume: { position: target, duration, fileIndex, at: new Date().toISOString() }
    })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

app.post('/api/torrents/:id/sync', async (req, res, next) => {
  try {
    const session = manager.get(req.params.id)
    const delayMs = Math.max(-5000, Math.min(5000, Math.round(Number(req.body?.delayMs) || 0)))
    const fileIndex = Number(req.body?.fileIndex ?? session.selectedFileIndex ?? 0)
    await manager.saveSync(session.id, fileIndex, delayMs)
    res.json({ ok: true, delayMs })
  } catch (err) {
    next(err)
  }
})

app.post('/api/torrents/:id/prepare', async (req, res, next) => {
  try {
    const session = manager.get(req.params.id)
    const index = Number(req.body?.fileIndex ?? session.selectedFileIndex ?? 0)
    const prepare = await manager.prepare(session.id, index)
    res.json({ ok: true, prepare })
  } catch (err) {
    next(err)
  }
})

app.get('/api/torrents/:id/prepare', async (req, res, next) => {
  try {
    const session = manager.get(req.params.id)
    res.json({ prepare: session.prepare ?? null })
  } catch (err) {
    next(err)
  }
})

/* Re-open a library item from its saved .torrent + bytes already on disk. */
app.post('/api/library/:infoHash/open', async (req, res, next) => {
  try {
    const infoHash = req.params.infoHash
    const session = await manager.reopen(infoHash)
    session.lastActionAt = Date.now()
    res.json({
      id: session.id,
      name: session.torrent.name,
      infoHash: session.torrent.infoHash,
      length: session.torrent.length,
      files: manager.videoFiles(session.torrent),
      allFileCount: session.torrent.files.length,
      status: manager.status(session)
    })
  } catch (err) {
    next(err)
  }
})

app.delete('/api/library/:infoHash', async (req, res, next) => {
  try {
    const infoHash = req.params.infoHash
    const freed = await manager.deleteData(infoHash, { keepMeta: false })
    manager.usage.invalidate?.()
    const bytes = await manager.usage.measure()
    res.json({ ok: true, freed, usage: bytes, limitBytes: STORAGE_LIMIT_BYTES })
  } catch (err) {
    next(err)
  }
})

app.post('/api/library/:infoHash/position', async (req, res, next) => {
  try {
    const position = Math.max(0, Number(req.body?.position) || 0)
    const duration = Math.max(0, Number(req.body?.duration) || 0)
    const fileIndex = Number(req.body?.fileIndex ?? 0) || 0
    const meta = await manager.library.patch(req.params.infoHash, {
      resume: { position, duration, fileIndex, at: new Date().toISOString() }
    })
    if (!meta) throw new HttpError(404, 'Unknown library item.')
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

app.post('/api/torrents/:id/stop-download', (req, res) => {
  const session = manager.sessions.get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Unknown torrent.' })
  // A paused player should not keep downloading or converting - close the ffmpeg
  // pipeline and let the swarm idle. Resuming re-creates the stream at position.
  manager.stopStreams(session)
  for (const f of session.torrent.files) f.deselect()
  session.prefetcher?.stop?.()
  res.json({ ok: true, streams: session.activeStreams.size })
})

/* --------------------------------------------------------------- events --- */

app.get('/api/torrents/:id/events', (req, res) => {
  const session = manager.sessions.get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Unknown torrent.' })
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive'
  })
  const send = async () => {
    if (res.writableEnded) return
    try {
      // The client expects the { status, usage } envelope. Sending the status object
      // on its own leaves `status` undefined on the other end, which threw on every
      // tick and silently froze the progress display.
      const status = manager.status(session)
      const usage = await manager.usage.usage()
      res.write(`data: ${JSON.stringify({ status, usage })}\n\n`)
    } catch {
      res.write('event: gone\ndata: {}\n\n')
    }
  }
  send()
  const timer = setInterval(send, 2000)
  timer.unref?.()
  req.on('close', () => {
    clearInterval(timer)
    res.end()
  })
})

/* -------------------------------------------------------------- streaming -- */

async function resolveStream (manager, id, index, hevcSupported = false, audioCodecs = {}) {
  const session = manager.get(id)
  const file = session.torrent.files[index]
  if (!file) throw new HttpError(404, 'Unknown file index.')
  const probe = await manager.probeFor(session, index)
  const plan = planPlayback({ fileName: file.name, probe, hevcSupported, audioCodecs })
  return { session, file, probe, plan }
}

/**
 * The torrent's own bytes over HTTP, with Range support.
 *
 * This exists so ffmpeg can read a *partially downloaded* file correctly. A local
 * file with missing pieces reads back as zeros, so ffmpeg decodes garbage and
 * never finds a picture - which is exactly the "no picture" failure on a seek.
 * Over HTTP every seek becomes a Range request, and the server answers it by
 * fetching precisely those pieces and holding the connection until they arrive.
 * Same idea as the range-serving proxy in webtor's self-hosted stack.
 */
app.get('/raw/:id/:index', async (req, res) => {
  const session = manager.sessions.get(req.params.id)
  const file = session?.torrent?.files?.[Number(req.params.index)]
  if (!session || !file) return res.status(404).json({ error: 'Unknown file.' })
  session.lastActionAt = Date.now()
  // A seek into pieces the swarm never delivers used to leave this range
  // request open forever (WebTorrent's FileIterator waits on 'verified' with
  // no timeout), so the browser spinner never stopped and the socket piled up
  // on reload. Give up after RAW_TIMEOUT_MS and let the player retry.
  const rawTimeoutMs = Number(process.env.RAW_TIMEOUT_MS || 90000)
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'Those pieces did not arrive from the swarm in time. Try again.' })
    } else {
      res.destroy(new Error('raw range timeout'))
    }
    log(`[raw] timeout for ${file.name} after ${rawTimeoutMs}ms`)
  }, rawTimeoutMs)
  timer.unref?.()
  const clear = () => clearTimeout(timer)
  res.on('close', clear)
  res.on('finish', clear)
  streamFileToResponse({
    req,
    res,
    file,
    contentType: 'application/octet-stream',
    prefetcher: session.prefetcher
  })
})

app.get('/stream/:id/:index', async (req, res) => {
  const id = req.params.id
  const index = Number(req.params.index)
  const mode = String(req.query.mode || 'auto')
  const startAt = Math.max(0, Number(req.query.t) || 0)
  // Absolute ffprobe stream index of the audio track to use, or null for the
  // first track. Choosing a different one forces the ffmpeg paths: a raw file
  // stream cannot honour the request, the browser just plays track 0.
  const audioStreamIndex = req.query.audio !== undefined && req.query.audio !== ''
    ? Math.max(0, Number(req.query.audio) || 0)
    : null
  const hevcSupported = req.query.hevc === '1'
  const audioCodecsStr = req.query.ac || ''
  const audioCodecs = {}
  for (const c of audioCodecsStr.split(',')) {
    if (c) audioCodecs[c] = true
  }
  const session = manager.sessions.get(id)

  // Register cleanup EARLY, before any await. A reload or a seek that swaps
  // video.src closes the request while we are still probing/priming; if the
  // close listener is attached later (as it used to be), that event has already
  // fired and ffmpeg is never killed — leaking a 100%-CPU process per seek.
  let liveRegistered = false
  const registerLive = () => {
    if (liveRegistered) return
    liveRegistered = true
    res.dshLivePipeline = true
    manager.beginLive()
  }
  // Single close handler, registered before any await: balances beginLive()
  // and tears down ffmpeg (via streaming.js's own early close listener).
  res.on('close', () => {
    if (liveRegistered) manager.endLive()
  })

  res.on('error', () => {})

  // Tracked so a paused player can close the pipeline and stop the download.
  if (session) {
    session.activeStreams.add(res)
    res.on('close', () => session.activeStreams.delete(res))
  }

  try {
    if (!session || session.torrent.destroyed) throw new HttpError(404, 'That torrent is not open any more.')
    session.lastActionAt = Date.now()

    // Already converted to a seekable MP4 earlier: serve it with Range support.
    if (mode === 'prepared') {
      const prepared = await manager.preparedInfo(id, index)
      if (!prepared) throw new HttpError(404, 'No seekable copy exists for this file yet.')
      return streamPreparedToResponse({ req, res, filePath: prepared.path, size: prepared.size })
    }

    const { file, plan, probe } = await resolveStream(manager, id, index, hevcSupported, audioCodecs)

    // Repaired MP4: index relocated to the front, served as an ordinary file so
    // the browser starts instantly and seeks natively - no ffmpeg, no live stream.
    if (mode === 'progressive' || (mode !== 'live' && plan.mode === 'progressive')) {
      if (audioStreamIndex == null) {
        const layout = await manager.faststartLayout(session, index)
        if (layout && !layout.passthrough) {
          log(`[stream] progressive MP4 for ${file.name} (${layout.shifted} chunk offsets relocated)`)
          return streamFaststartToResponse({ req, res, file, layout, prefetcher: session.prefetcher })
        }
        if (layout?.passthrough) {
          // Already faststart: the raw range endpoint streams and seeks it natively.
          return streamFileToResponse({ req, res, file, contentType: mimeOf(file.name), prefetcher: session.prefetcher })
        }
      }
      // Repair not possible (or a specific audio track was requested): fall
      // through to the conversion paths.
      plan.mode = 'remux'
    }

    if (audioStreamIndex == null && (mode === 'direct' || (mode !== 'live' && plan.mode === 'direct'))) {
      return streamFileToResponse({
        req,
        res,
        file,
        contentType: mimeOf(file.name),
        prefetcher: session.prefetcher
      })
    }

    // Otherwise we are in the ffmpeg path. If the user picked a specific audio
    // track, a "native" plan must become a copy-remux so the track is honoured.
    if (audioStreamIndex != null && (plan.mode === 'direct' || plan.mode === 'progressive')) {
      plan.mode = 'remux'
      plan.videoCopy = true
      plan.audioCopy = true
    }

    // A seek past the downloaded prefix is not an error: prime the swarm with the
    // pieces for that timestamp and let ffmpeg pull them over the range endpoint
    // as it starts. Clicking 45:00 does not require the first 45 minutes to land.
    const duration = probe?.duration ?? 0
    const playable = manager.playableSeconds(session.torrent, file, duration)
    let fetching = false
    if (startAt > 0 && playable > 0 && startAt > playable + 5) {
      fetching = true
      log(`[seek] ${Math.round(startAt)}s is beyond the ${Math.round(playable)}s downloaded - priming those pieces`)
      await manager.ensureSeekTarget(session, index, startAt, { duration, log })
    }

    // Seeking is far cheaper against the on-disk file (a real file, so ffmpeg
    // jumps straight to the keyframe) than decode-discarding from byte 0 - but
    // only when the file is actually complete. A partial file has holes, and
    // ffmpeg would read zeros where the missing pieces are; in that case it reads
    // the torrent through /raw/ instead, which fetches on demand and never lies.
    const diskPath = manager.diskPath(session.torrent, file)
    const rawUrl = `http://127.0.0.1:${PORT}/raw/${id}/${index}`
    const inputPath = file.done ? diskPath : null
    const inputUrl = file.done ? null : rawUrl
    if (fetching || !file.done) {
      log(`[stream] ${file.done ? 'local file' : 'range-backed'} source for ${file.name}${startAt ? ` @ ${Math.round(startAt)}s` : ''}`)
    }

    // ffmpeg path. If the live pipeline cannot produce a frame but the file is
    // already complete on disk, transparently retry from the file instead.
    // Flagged as abortable: this is the only kind of response that may be torn
    // down when playback pauses, because it is the only one consuming CPU.
    res.dshLivePipeline = true
    // Freeze any background prepare job while the live conversion is running so
    // the two ffmpeg processes cannot starve each other of CPU. The prepare
    // resumes from the same byte once playback stops.
    // Browsers cannot advance audio (negative delay) in a DelayNode, so the
    // live pipeline bakes the full saved/requested offset into the stream.
    // The client only sends negative values on this path; positive values stay
    // in the Web Audio graph for instant +/- tweaks.
    if (res.destroyed) return // client vanished during the awaits above
    registerLive()
    const audioDelayMs = Math.max(-5000, Math.min(5000, Math.round(Number(req.query.audioDelay) || 0)))
    try {
      await streamTranscodedToResponse({
        req,
        res,
        file,
        plan,
        prefetcher: session.prefetcher,
        inputPath,
        inputUrl,
        startAt,
        audioStreamIndex,
        audioDelayMs
      })
    } catch (err) {
      if (res.headersSent) {
        log(`[stream] pipeline failed mid-stream: ${err.message}`)
        return res.destroy(err)
      }
      if (inputPath) {
        log(`[stream] local-file pipeline failed (${err.detail || err.message}); retrying over HTTP`)
        return await streamTranscodedToResponse({ req, res, file, plan, inputUrl: rawUrl, startAt, audioStreamIndex, audioDelayMs })
      }
      throw err
    }
  } catch (err) {
    if (res.headersSent) return res.destroy(err)
    const status = err.status || (err.code === 'PIPELINE_FAILED' ? 502 : 500)
    log(`[stream] ${status} ${err.message}${err.stderr ? ` :: ${err.stderr.slice(-400)}` : ''}`)
    res.status(status).json({
      error: err.message,
      detail: err.detail ?? null,
      hint: err.code === 'PIPELINE_FAILED' || status === 502
        ? 'The conversion pipeline could not start. Check that ffmpeg is installed and that peers are supplying data.'
        : null
    })
  }
})

/* -------------------------------------------------------------- subtitles -- */

app.get('/api/torrents/:id/:index/subtitles', async (req, res, next) => {
  try {
    const session = manager.get(req.params.id)
    const index = Number(req.params.index)
    await manager.probeFor(session, index)
    res.json(await manager.subtitleTracks(session, index))
  } catch (err) {
    next(err)
  }
})

app.post('/api/torrents/:id/:index/subtitles/search', async (req, res, next) => {
  try {
    const session = manager.get(req.params.id)
    res.json(await manager.searchSubtitles(session, Number(req.params.index), req.body ?? {}))
  } catch (err) {
    logError('subtitles/search', err)
    next(err)
  }
})

app.post('/api/torrents/:id/:index/subtitles/fetch', async (req, res, next) => {
  try {
    const session = manager.get(req.params.id)
    const saved = await manager.fetchSubtitle(session, Number(req.params.index), req.body ?? {})
    res.json({ ok: true, subtitle: saved, url: `/subs/${session.id}/${Number(req.params.index)}/${encodeURIComponent(saved.id)}` })
  } catch (err) {
    logError(`subtitles/fetch`, err)
    next(err)
  }
})

app.delete('/api/torrents/:id/:index/subtitles/:subId', async (req, res, next) => {
  try {
    const session = manager.get(req.params.id)
    res.json(await manager.removeSubtitle(session, Number(req.params.index), req.params.subId))
  } catch (err) {
    next(err)
  }
})

app.post('/api/torrents/:id/:index/subtitles/select', async (req, res, next) => {
  try {
    const session = manager.get(req.params.id)
    const trackId = req.body?.trackId ?? null
    await manager.saveSubSelection(session.id, Number(req.params.index), trackId)
    res.json({ ok: true, trackId })
  } catch (err) {
    next(err)
  }
})

app.post('/api/torrents/:id/:index/subtitles/sync', async (req, res, next) => {
  try {
    const session = manager.get(req.params.id)
    const trackId = req.body?.trackId
    const syncs = await manager.saveSubSync(session.id, Number(req.params.index), trackId, {
      offsetMs: req.body?.offsetMs,
      scale: req.body?.scale
    })
    res.json({ ok: true, syncs })
  } catch (err) {
    next(err)
  }
})

/**
 * Serve a WebVTT track. Embedded tracks are extracted on first request and then
 * cached; downloaded ones are already on disk.
 */
app.get('/subs/:id/:index/:track', async (req, res) => {
  const id = req.params.id
  const index = Number(req.params.index)
  const session = manager.sessions.get(id)
  if (!session) return res.status(404).json({ error: 'Unknown torrent.' })

  let filePath = null
  try {
    const track = String(req.params.track)
    if (track.startsWith('embedded-')) {
      const streamIndex = Number(track.slice('embedded-'.length))
      const extracted = await manager.extractEmbeddedSubtitle(session, index, streamIndex)
      filePath = extracted.path
    } else if (track.startsWith('bundled-')) {
      const extracted = await manager.extractBundledSubtitle(session, Number(track.slice('bundled-'.length)))
      filePath = extracted.path
    } else {
      const listed = await manager.subtitles.list(id, index)
      const match = listed.find(t => t.id === track)
      if (!match) return res.status(404).json({ error: 'Unknown subtitle.' })
      filePath = path.join(manager.subtitles.infoHashDir(id), path.basename(match.id))
    }
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    // sendFile's `dotfiles: ignore` default rejects the `.subs/` folder, so use
    // a plain read stream - the cache layer just needs a 200 + body.
    // `?offset=<ms>&scale=<ratio>` rewrites cue timings on the fly: browsers
    // expose TextTrack cues read-only, so shifting has to happen server-side.
    try {
      const offset = Number(req.query.offset) || 0
      const scale = Number(req.query.scale) || 1
      const text = await fs.readFile(filePath, 'utf8')
      res.status(200).send(shiftVttTimestamps(text, { offsetMs: offset, scale }))
    } catch (err) {
      res.status(404).json({ error: 'Subtitle file missing.' })
    }
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

/* ----------------------------------------------------------------- static -- */

// Static assets are never cached: a stale app.js is indistinguishable from a bug
// in the player, and that has already cost us one debugging round.
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  etag: false,
  lastModified: false,
  setHeaders: res => res.setHeader('Cache-Control', 'no-store, must-revalidate')
}))
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate')
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'))
})

app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }))

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500
  if (status >= 500) log(`[error] ${err.stack || err.message}`)
  const payload = { error: err.message || 'Unexpected error' }
  if (err.hint) payload.hint = err.hint
  if (err.detail) payload.detail = err.detail
  res.status(status).json(payload)
})

app.listen(PORT, HOST, () => {
  log(`webtorent listening on http://${HOST}:${PORT}`)
  log(`data dir: ${DATA_DIR}`)
  // Kill any orphaned ffmpeg processes from a previous server instance.
  // They keep writing to .seekable/*.part and would compete with the new one.
  try {
    const out = execSync('pgrep -f "ffmpeg.*\\.seekable"', { encoding: 'utf8' }).trim()
    for (const pid of out.split('\n').filter(Boolean)) {
      try { process.kill(Number(pid), 'SIGKILL') } catch { /* already gone */ }
    }
    if (out) log(`[startup] killed ${out.split('\n').length} orphaned ffmpeg process(es)`)
  } catch { /* no orphans */ }
  // Re-open saved torrents from disk so a server restart does not look like a
  // stopped download - they rejoin their swarm and appear in the UI again.
  // Progress is preserved because WebTorrent stores pieces in DATA_DIR.
  manager.restoreAll().catch(err => log(`[restore] ${err.message}`))
})
