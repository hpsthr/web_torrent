/* webtorent client: paste a magnet, watch it, keep an eye on the buffer. */

const $ = id => document.getElementById(id)
const els = {
  ffmpegBadge: $('ffmpeg-badge'),
  storageFill: $('storage-fill'),
  storageText: $('storage-text'),
  dataPath: $('data-path'),
  addForm: $('add-form'),
  magnet: $('magnet'),
  addBtn: $('add-btn'),
  addStatus: $('add-status'),
  torrentCard: $('torrent-card'),
  torrentName: $('torrent-name'),
  torrentMeta: $('torrent-meta'),
  closeTorrent: $('close-torrent'),
  fileSelect: $('file-select'),
  playBtn: $('play-btn'),
  fileProgress: $('file-progress'),
  fileProgressText: $('file-progress-text'),
  keepBtn: $('keep-btn'),
  prepareBtn: $('prepare-btn'),
  deleteBtn: $('delete-btn'),
  autodelete: $('autodelete'),
  actionStatus: $('action-status'),
  playerCard: $('player-card'),
  video: $('video'),
  overlay: $('overlay'),
  overlayText: $('overlay-text'),
  back10: $('back10'),
  fwd10: $('fwd10'),
  playPause: $('playpause'),
  seekRange: $('seek-range'),
  timeNow: $('time-now'),
  timeTotal: $('time-total'),
  seekNote: $('seek-note'),
  stage: $('stage'),
  controls: $('controls'),
  mute: $('mute'),
  syncBtn: $('sync-btn'),
  syncPanel: $('sync-panel'),
  syncClose: $('sync-close'),
  syncMinus: $('sync-minus'),
  syncPlus: $('sync-plus'),
  syncReset: $('sync-reset'),
  syncValue: $('sync-value'),
  syncNote: $('sync-note'),
  subsBtn: $('subs-btn'),
  subsPanel: $('subs-panel'),
  subsClose: $('subs-close'),
  audioBtn: $('audio-btn'),
  audioPanel: $('audio-panel'),
  audioClose: $('audio-close'),
  audioList: $('audio-list'),
  subsList: $('subs-list'),
  subsProvider: $('subs-provider'),
  subsStatus: $('subs-status'),
  subsQuery: $('subs-query'),
  subsLang: $('subs-lang'),
  subsSearchBtn: $('subs-search-btn'),
  subsResults: $('subs-results'),
  subsyncMinus: $('subsync-minus'),
  subsyncPlus: $('subsync-plus'),
  subsyncReset: $('subsync-reset'),
  subsyncValue: $('subsync-value'),
  subsyncScale: $('subsync-scale'),
  volume: $('volume'),
  fullscreen: $('fullscreen'),
  chipMode: $('chip-mode'),
  chipPeers: $('chip-peers'),
  chipSpeed: $('chip-speed'),
  chipBuffer: $('chip-buffer'),
  chipRatio: $('chip-ratio'),
  modeReason: $('mode-reason'),
  quotaWarn: $('quota-warn'),
  playerWarn: $('player-warn'),
  libraryCard: $('library-card'),
  libraryList: $('library-list'),
  libraryEmpty: $('library-empty'),
  librarySummary: $('library-summary'),
  toasts: $('toasts')
}

const state = {
  id: null,
  name: null,
  infoHash: null,
  files: [],
  index: 0,
  plan: null,
  ladder: [],
  rung: 0,
  playing: false,
  events: null,
  watchdog: null,
  noPictureSince: null,
  lastSaved: 0,
  duration: 0,
  playable: 0,
  seekable: false,
  mode: null,
  nativeSeek: false,
  streamOffset: 0,
  streamClosed: false,
  subtitleTracks: null,
  subtitleResults: null,
  subtitleQuery: null,
  // Current subtitle choice as an id (`embedded-3`, `bundled-2`, or a `.vtt`
  // file name) plus its timing. `activeSubtitle` kept as the resolved URL.
  subtitle: null,
  activeSubtitle: null,
  activeSubtitleId: null,
  audioDelayMs: 0,
  audioNudgeApplied: 0,
  savedSubtitle: null,
  audioTrack: null,
  resumeAt: 0,
  upgrading: false,
  usage: { bytes: 0, limitBytes: 0 },
  limits: { storageLabel: '8 GB' }
}

/* ------------------------------------------------------------------ utils */

function toast (message, kind = '') {
  const node = document.createElement('div')
  node.className = `toast ${kind}`
  node.textContent = message
  els.toasts.appendChild(node)
  setTimeout(() => node.remove(), kind === 'err' ? 9000 : 5200)
}

function bytes (value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function clock (seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const s = Math.floor(seconds % 60)
  const m = Math.floor((seconds / 60) % 60)
  const h = Math.floor(seconds / 3600)
  const pad = n => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function percent (value) {
  return `${Math.round((Number(value) || 0) * 100)}%`
}

async function api (url, options = {}) {
  const response = await fetch(url, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { error: text } }
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status})`)
    error.status = response.status
    error.payload = data
    throw error
  }
  return data
}

function setStorage (usage) {
  if (!usage) return
  state.usage = usage
  const ratio = usage.limitBytes ? usage.bytes / usage.limitBytes : 0
  els.storageFill.style.width = `${Math.min(100, ratio * 100).toFixed(1)}%`
  els.storageFill.classList.toggle('hot', ratio > 0.85)
  els.storageText.textContent = `${bytes(usage.bytes)} / ${bytes(usage.limitBytes)}`
}

function explain (error) {
  if (error.status === 507) return `${error.message} (limit ${state.limits.storageLabel})`
  return error.message
}

/* ------------------------------------------------------------------ health */

async function loadHealth () {
  try {
    const health = await api('/api/health')
    state.limits = health.limits
    setStorage(health.usage)
    els.dataPath.textContent = health.paths.data
    if (health.ffmpeg.ffmpeg) {
      els.ffmpegBadge.textContent = `ffmpeg ready · ${health.ffmpeg.version.split(' ')[2] ?? ''}`.trim()
      els.ffmpegBadge.className = 'tag ok'
    } else {
      els.ffmpegBadge.textContent = 'ffmpeg missing — mkv/avi cannot play'
      els.ffmpegBadge.className = 'tag bad'
    }
  } catch (error) {
    els.ffmpegBadge.textContent = 'server unreachable'
    els.ffmpegBadge.className = 'tag bad'
  }
}

/* ---------------------------------------------------------------- add flow */

els.addForm.addEventListener('submit', async event => {
  event.preventDefault()
  const magnet = els.magnet.value.trim()
  if (!magnet) return

  els.addBtn.disabled = true
  const started = Date.now()
  const ticker = setInterval(() => {
    els.addStatus.textContent = `Fetching metadata from peers… ${Math.round((Date.now() - started) / 1000)}s`
  }, 500)
  els.addStatus.textContent = 'Fetching metadata from peers…'

  try {
    const data = await api('/api/torrents', { method: 'POST', body: { magnet } })
    state.id = data.id
    state.infoHash = data.infoHash
    state.name = data.name
    state.files = data.files
    els.addStatus.textContent = ''
    els.magnet.value = ''
    renderTorrent(data)
    renderLibrary()
    toast(`Opened “${data.name}”`, 'ok')
  } catch (error) {
    els.addStatus.textContent = ''
    toast(explain(error), 'err')
  } finally {
    clearInterval(ticker)
    els.addBtn.disabled = false
  }
})

function renderTorrent (data) {
  els.torrentCard.classList.remove('hidden')
  els.torrentName.textContent = data.name
  els.torrentMeta.textContent = `${data.files.length} video file${data.files.length === 1 ? '' : 's'} · ${bytes(data.length)} total · ${data.allFileCount ?? data.files.length} files in torrent`

  els.fileSelect.innerHTML = ''
  if (data.files.length === 0) {
    els.fileSelect.innerHTML = '<option>no video files found</option>'
    els.playBtn.disabled = true
    return
  }
  els.playBtn.disabled = false
  for (const file of data.files) {
    const option = document.createElement('option')
    option.value = String(file.index)
    option.textContent = `${file.name} — ${bytes(file.length)}`
    els.fileSelect.appendChild(option)
  }

  // Default to the biggest video file: usually the feature, not a sample.
  const biggest = data.files.reduce((best, file) => (file.length > best.length ? file : best), data.files[0])
  els.fileSelect.value = String(biggest.index)

  els.fileProgress.style.width = '0%'
  els.fileProgressText.textContent = 'not downloading — press Play'
  els.actionStatus.textContent = ''
  els.prepareBtn.disabled = false
  subscribe(data.id)
}

/* ------------------------------------------------------------------- play */

els.playBtn.addEventListener('click', () => {
  if (!state.id) return
  startPlayback(Number(els.fileSelect.value))
})

// Switching file while something is playing should switch playback too, rather
// than silently keep showing the previous episode.
els.fileSelect.addEventListener('change', () => {
  if (!state.id || !state.playing) return
  state.playing = false
  startPlayback(Number(els.fileSelect.value))
})

async function startPlayback (index) {
  state.index = index
  state.upgrading = false
  els.playerWarn.classList.add('hidden')
  els.prepareBtn.textContent = 'Make seekable'
  hideOverlay()

  try {
    const data = await api(`/api/torrents/${state.id}/play`, {
      method: 'POST',
      body: { fileIndex: index, keepData: !els.autodelete.checked, hevcSupported, audioCodecs: Object.keys(audioCodecs).filter(k => audioCodecs[k]).join(',') }
    })
    state.plan = data
    state.duration = Number(data.duration) || 0
    state.seekable = Boolean(data.seekable)

    els.playerCard.classList.remove('hidden')
    els.modeReason.textContent = data.reason
    els.timeTotal.textContent = state.duration ? clock(state.duration) : '--:--'
    els.prepareBtn.disabled = Boolean(data.prepared)

    if (data.quotaLimited) {
      els.playerWarn.classList.remove('hidden')
      els.playerWarn.textContent = 'Storage limit reached - streaming windows only. Seeking needs the whole file on disk.'
    }

    state.ladder = buildLadder(data)
    state.rung = 0
    els.subsPanel.classList.add('gone')
    els.syncPanel.classList.add('gone')
    els.subsResults.innerHTML = ''
    els.subsStatus.textContent = ''
    // A new file starts with no track: the old <track> element used to survive
    // the source swap and keep showing the previous file's subtitles.
    clearSubtitleTrack()
    state.subtitleResults = null
    state.subtitleQuery = null
    state.savedSubtitle = data.subtitle ?? null
    // A/V delay is per file - each scene in a split release can need its own.
    state.audioDelayMs = Number(data.sync) || 0
    state.audioTrack = null
    els.syncValue.textContent = `${state.audioDelayMs > 0 ? '+' : ''}${state.audioDelayMs} ms`
    if (state.audioDelayMs !== 0) applyAudioDelay(state.audioDelayMs, { restart: false })
    seedSubtitleQuery()
    els.playerCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' })

    if (data.prepared) {
      // A seekable copy already exists: always prefer it, it seeks properly.
      state.rung = state.ladder.findIndex(rung => rung.mode === 'prepared')
      startStream('prepared')
    } else {
      startStream(state.ladder[0].mode)
    }
    // Load this file's subtitle list and re-apply the remembered choice
    // (explicit Off stays off; never-chosen auto-picks bundled/embedded).
    restoreSubtitleChoice()
  } catch (error) {
    toast(explain(error), 'err')
  }
}

/**
 * Which transport to try, in order.
 *
 * `direct` is raw bytes (browser decodes it - a stalled non-faststart MP4 lands
 * here and needs the fallback), `live` forces ffmpeg, `prepared` is the finished
 * seekable MP4.
 */
const MODE_LABELS = {
  direct: 'Direct stream',
  progressive: 'Native MP4 (index at front)',
  prepared: 'Seekable copy (native seek)',
  auto: 'Remux (live)',
  live: 'Converting (live)'
}

function buildLadder (data) {
  if (data.mode === 'direct' || data.mode === 'progressive') {
    return [
      { mode: data.mode, label: data.mode === 'progressive' ? 'Native (index relocated)' : 'Direct stream' },
      { mode: 'live', label: 'Converting (live)' }
    ]
  }
  return [
    { mode: 'auto', label: data.mode === 'remux' ? 'Remux (no re-encode)' : 'Transcoding' }
  ]
}

function startStream (mode, { resumeAt = null } = {}) {
  const params = new URLSearchParams({ mode })
  if (hevcSupported) params.set('hevc', '1')
  params.set('ac', Object.keys(audioCodecs).filter(k => audioCodecs[k]).join(','))
  if (state.audioTrack != null) params.set('audio', String(state.audioTrack))
  // Negative audio delay (audio ahead of picture) is baked in by the live
  // converter; the browser graph can only hold audio back.
  const live = !(mode === 'prepared' || mode === 'direct' || mode === 'progressive')
  if (live && (state.audioDelayMs || 0) < 0) params.set('audioDelay', String(state.audioDelayMs))
  const nativeSeek = mode === 'prepared' || mode === 'direct' || mode === 'progressive'

  // A live remux/transcode stream has no index, so the browser cannot seek it.
  // We ask the server for that timestamp instead, and remember where the stream
  // begins so the timeline can still show real movie time.
  if (!nativeSeek && resumeAt) params.set('t', resumeAt.toFixed(2))

  const url = `/stream/${state.id}/${state.index}?${params}`
  const rung = state.ladder[Math.max(0, state.rung)]
  state.playing = true
  state.mode = mode
  state.nativeSeek = nativeSeek
  state.streamOffset = (!nativeSeek && resumeAt) ? resumeAt : 0
  state.noPictureSince = null

  els.video.src = url
  els.video.load()

  // The source swap resets what the browser shows for text tracks, so rebuild
  // the current subtitle element against the new stream. No-op when Off.
  if (state.subtitle) applySubtitleTrack(state.subtitle, { silent: true, persist: false })

  if (nativeSeek && resumeAt) {
    // A seekable source: the browser can be positioned directly.
    state.resumeAt = resumeAt
    els.video.addEventListener('loadedmetadata', () => {
      try { els.video.currentTime = resumeAt } catch { /* not ready */ }
    }, { once: true })
  }

  // Name the transport that is actually running. Reading the ladder rung said
  // "Remux (no re-encode)" even while the seekable copy was playing, which made a
  // healthy native stream look like the live fallback.
  els.chipMode.textContent = `mode ${MODE_LABELS[mode] ?? rung?.label ?? mode}`
  els.chipMode.className = 'chip busy'
  els.overlayText.textContent = rung?.label ? `${rung.label}…` : 'loading…'
  showOverlay()
  els.video.play().catch(() => { /* a click may be needed */ })
  startWatchdog()
  updateTimeline()
  showControls()
}

/** Where we are in the movie, in seconds - not in the current HTTP stream. */
function currentPosition () {
  return (state.streamOffset || 0) + (els.video.currentTime || 0)
}

/**
 * Jump the playhead. Seekable sources move natively; live streams are re-opened
 * at the timestamp, which the server resolves by fetching those exact pieces.
 */
function seekTo (seconds) {
  if (!state.playing) return
  const target = clampTarget(seconds)

  // Tell the server where we are going *now*. Otherwise it keeps filling the old
  // read-ahead window first (both windows are the same priority), and the pieces
  // for the new position queue behind data we no longer need.
  if (state.id) {
    api(`/api/torrents/${state.id}/playhead`, {
      method: 'POST',
      body: { position: target, duration: state.duration, paused: els.video.paused }
    }).catch(() => {})
  }

  if (state.nativeSeek) {
    try {
      els.video.currentTime = target
      els.video.play().catch(() => {})
      updateTimeline()
      return
    } catch { /* fall through to a re-open */ }
  }

  if (state.playable && target > state.playable + 5) {
    els.overlayText.textContent = `fetching ${clock(target)} from peers…`
    showOverlay()
  }
  startStream(state.mode, { resumeAt: target })
}

function skipBy (delta) {
  seekTo(currentPosition() + delta)
}

els.back10.addEventListener('click', () => skipBy(-10))
els.fwd10.addEventListener('click', () => skipBy(10))

/* ------------------------------------------- overlay controls + fullscreen -- */

/**
 * Controls live on the picture and fade out while you watch.
 *
 * They stay put whenever playback is paused - hiding the controls on a paused
 * frame would leave nothing to click.
 */
let controlsTimer = null
function showControls () {
  els.controls.classList.remove('gone')
  els.stage.classList.remove('idle')
  clearTimeout(controlsTimer)
  if (!els.video.paused && state.playing) {
    controlsTimer = setTimeout(hideControls, 2600)
  }
}
function hideControls () {
  // Never hide out from under someone who is dragging the bar.
  if (dragging || els.video.paused) return
  els.controls.classList.add('gone')
  els.stage.classList.add('idle')
}

// Any movement over the picture (including down to the bottom edge) brings them back.
for (const event of ['mousemove', 'pointerdown', 'touchstart']) {
  els.stage.addEventListener(event, showControls, { passive: true })
}
els.stage.addEventListener('mouseleave', () => {
  if (!els.video.paused) hideControls()
})
els.video.addEventListener('play', showControls)
els.video.addEventListener('pause', () => {
  clearTimeout(controlsTimer)
  els.controls.classList.remove('gone')
  els.stage.classList.remove('idle')
})
// Keep them up while the pointer is on the bar itself.
els.controls.addEventListener('mouseenter', () => clearTimeout(controlsTimer))
els.controls.addEventListener('mouseleave', () => { if (!els.video.paused) controlsTimer = setTimeout(hideControls, 1600) })

function isFullscreen () {
  return document.fullscreenElement === els.stage || document.webkitFullscreenElement === els.stage
}
function toggleFullscreen () {
  if (isFullscreen()) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document)
  } else {
    const request = els.stage.requestFullscreen || els.stage.webkitRequestFullscreen
    request?.call(els.stage).catch(() => toast('Fullscreen was blocked by the browser.', 'err'))
  }
}
els.fullscreen.addEventListener('click', toggleFullscreen)
els.video.addEventListener('dblclick', toggleFullscreen)

function syncFullscreenIcon () {
  els.fullscreen.textContent = isFullscreen() ? '⤢' : '⛶'
  els.fullscreen.title = isFullscreen() ? 'Exit fullscreen (f)' : 'Fullscreen (f)'
  showControls()
}
document.addEventListener('fullscreenchange', syncFullscreenIcon)
document.addEventListener('webkitfullscreenchange', syncFullscreenIcon)

function syncVolume () {
  els.volume.value = String(els.video.muted ? 0 : els.video.volume)
  els.mute.textContent = els.video.muted || els.video.volume === 0 ? '🔇' : '🔊'
}
els.volume.addEventListener('input', () => {
  els.video.volume = Number(els.volume.value)
  els.video.muted = els.video.volume === 0
  syncVolume()
})
els.mute.addEventListener('click', () => {
  els.video.muted = !els.video.muted
  syncVolume()
  showControls()
})
syncVolume()

els.playPause.addEventListener('click', () => {
  if (els.video.paused) els.video.play().catch(() => {})
  else els.video.pause()
})

els.video.addEventListener('play', () => { els.playPause.textContent = '❚❚' })
els.video.addEventListener('pause', () => { els.playPause.textContent = '▶' })

// Single click toggles playback, double click goes fullscreen - so the first
// click has to wait briefly to find out which one it was.
let clickTimer = null
els.video.addEventListener('click', () => {
  clearTimeout(clickTimer)
  clickTimer = setTimeout(() => {
    if (els.video.paused) els.video.play().catch(() => {})
    else els.video.pause()
    showControls()
  }, 220)
})
els.video.addEventListener('dblclick', () => clearTimeout(clickTimer))

// Timeline: dragging sets the position, playback moves the handle.
let dragging = false
els.seekRange.addEventListener('input', () => {
  dragging = true
  els.timeNow.textContent = clock(Number(els.seekRange.value))
})
els.seekRange.addEventListener('change', () => {
  const target = Number(els.seekRange.value)
  dragging = false
  seekTo(target)
})

function updateTimeline () {
  const duration = state.duration || 0
  const position = currentPosition()
  els.timeNow.textContent = clock(position)
  els.timeTotal.textContent = duration ? clock(duration) : '--:--'

  if (!dragging) {
    els.seekRange.max = String(duration || 1)
    els.seekRange.value = String(Math.min(position, duration || 1))
  }
  const pct = duration ? (position / duration) * 100 : 0
  // A seekable source can reach the whole film (the browser just asks for the
  // bytes); a live stream can only reach what has downloaded so far.
  const loaded = state.nativeSeek
    ? 100
    : (duration ? Math.min(100, ((state.playable || duration) / duration) * 100) : 100)
  els.seekRange.style.setProperty('--progress', pct.toFixed(2))
  els.seekRange.style.setProperty('--loaded', Math.max(pct, loaded).toFixed(2))
}

els.video.addEventListener('timeupdate', updateTimeline)
els.video.addEventListener('durationchange', updateTimeline)
els.video.addEventListener('ended', () => {
  els.controls.classList.remove('gone')
  els.stage.classList.remove('idle')
})

// Arrow keys = -10 / +10, space = play/pause, f = fullscreen, m = mute.
window.addEventListener('keydown', event => {
  if (!state.playing) return
  const active = document.activeElement
  const tag = active?.tagName
  // Only real text entry should swallow the arrows; a focused <select> (the file
  // picker, the subtitle language) would otherwise eat them silently, which made
  // the +/-10 shortcuts look broken after using a dropdown.
  if (tag === 'INPUT' || tag === 'TEXTAREA' || active?.isContentEditable) return
  if (tag === 'SELECT') active.blur()
  if (event.key === 'ArrowLeft' || event.key === 'j') {
    event.preventDefault()
    skipBy(-10)
  } else if (event.key === 'ArrowRight' || event.key === 'l') {
    event.preventDefault()
    skipBy(10)
  } else if (event.key === ' ' || event.key === 'k') {
    event.preventDefault()
    if (els.video.paused) els.video.play().catch(() => {})
    else els.video.pause()
  } else if (event.key === 'f') {
    event.preventDefault()
    toggleFullscreen()
  } else if (event.key === 'm') {
    event.preventDefault()
    els.video.muted = !els.video.muted
    syncVolume()
  } else if (event.key === 'c') {
    event.preventDefault()
    if (els.subsPanel.classList.contains('gone')) openSubsPanel()
    else els.subsPanel.classList.add('gone')
  }
  showControls()
})

/** Clamp to the movie's real end; never to the downloaded prefix - the server
 *  fetches any missing pieces for a forward seek, so the whole timeline is reachable. */
function clampTarget (seconds) {
  if (!state.duration) return Math.max(0, seconds)
  return Math.max(0, Math.min(seconds, state.duration - 1))
}

function escalate (reason) {
  if (!state.playing) return
  const next = state.ladder[state.rung + 1]
  if (!next) {
    stopWatchdog()
    hideOverlay()
    els.chipMode.className = 'chip bad'
    els.playerWarn.classList.remove('hidden')
    // Seeking fetches its own pieces, so a failure here means the swarm is not
    // delivering - not that the whole file has to be downloaded first.
    els.playerWarn.textContent = `Playback stalled (${reason}). `
      + `The pieces for this position are still coming from the swarm`
      + (state.playable ? ` (downloaded to ${clock(state.playable)} so far)` : '')
      + '. Try again in a moment, or pick another file.'
    return
  }
  state.rung += 1
  // Carry the playhead across. Without this the fallback silently restarted the
  // film from the beginning, which looked like an unprompted jump to zero.
  const at = currentPosition()
  toast(`${reason} — trying “${next.label}”…`)
  startStream(next.mode, { resumeAt: at })
}

els.video.addEventListener('error', () => {
  if (!state.playing) return
  // When playback pauses we deliberately close the live conversion pipeline, which
  // the element reports as an error. That is not a reason to switch strategy.
  if (els.video.paused || state.streamClosed) return
  escalate('the player rejected this stream')
})

els.video.addEventListener('playing', () => {
  hideOverlay()
  els.chipMode.className = 'chip live'
})

// A live stream re-buffers for a fraction of a second all the time, and flashing
// "buffering…" for that is noise. Only surface it if the wait is a real one.
let waitingTimer = null
els.video.addEventListener('waiting', () => {
  clearTimeout(waitingTimer)
  waitingTimer = setTimeout(() => {
    if (els.video.readyState < 3 && !els.video.paused) {
      els.overlayText.textContent = 'buffering…'
      showOverlay()
    }
  }, 1200)
})
els.video.addEventListener('playing', () => { clearTimeout(waitingTimer); hideOverlay() })
els.video.addEventListener('loadeddata', () => hideOverlay())
els.video.addEventListener('timeupdate', () => {
  clearTimeout(waitingTimer)
  if ((els.video.currentTime || 0) > 0.05) hideOverlay()
})

els.video.addEventListener('canplay', () => hideOverlay())

/**
 * Watchdog for the one failure the `error` event cannot report: a stream that
 * connects but never produces a decodable frame (for example an MP4 whose moov
 * atom sits at the end of the file). Nothing is "wrong" - it simply never starts.
 */
function startWatchdog () {
  stopWatchdog()
  let lastProgressAt = Date.now()
  let lastTime = -1
  let lastBufferedEnd = 0
  state.watchdog = setInterval(() => {
    if (!state.playing) return
    const video = els.video
    // A live-converted stream keeps only a couple of seconds by design; calling
    // that a plain "buffer 2.3s" invites alarm, so name it for what it is.
    const ahead = bufferAhead()
    els.chipBuffer.textContent = state.nativeSeek
      ? `buffer ${ahead.toFixed(1)}s`
      : `live buffer ${ahead.toFixed(1)}s`
    // Progress is either the playhead moving OR new data arriving in the
    // buffer. The old check (readyState === 0) missed the exact stall we care
    // about: an fMP4 keeps HAVE_METADATA with a dead buffer and no frame, so
    // it never escalated and the spinner stayed up forever.
    const advanced = video.currentTime > lastTime + 0.05
    let bufferedEnd = 0
    try {
      for (let i = 0; i < video.buffered.length; i++) {
        bufferedEnd = Math.max(bufferedEnd, video.buffered.end(i))
      }
    } catch { /* not ready yet */ }
    const dataArrived = bufferedEnd > lastBufferedEnd + 0.05
    lastTime = video.currentTime
    lastBufferedEnd = bufferedEnd
    if (advanced || dataArrived) {
      lastProgressAt = Date.now()
      return
    }
    // Paused means "waiting for the user", not stuck. A live stream buffers
    // only a few seconds by design, so use a generous threshold.
    if (video.paused) { lastProgressAt = Date.now(); return }
    if (Date.now() - lastProgressAt > 60000) {
      lastProgressAt = Date.now()
      escalate('no picture or new data for 60s')
    }
  }, 1000)
}

function stopWatchdog () {
  if (state.watchdog) clearInterval(state.watchdog)
  state.watchdog = null
}

function bufferAhead () {
  const video = els.video
  try {
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime && video.currentTime <= video.buffered.end(i)) {
        return video.buffered.end(i) - video.currentTime
      }
    }
  } catch { /* buffered can throw before metadata */ }
  return 0
}

function showOverlay () { els.overlay.classList.remove('hidden') }
function hideOverlay () { els.overlay.classList.add('hidden') }

/* ------------------------------------------------------------------ events */

function subscribe (id) {
  if (state.events) state.events.close()
  state.events = new EventSource(`/api/torrents/${id}/events`)

  state.events.onmessage = event => {
    let payload
    try { payload = JSON.parse(event.data) } catch { return }
    const { status, usage } = payload
    // Guard the shape. A server-side change to this payload used to throw here on
    // every tick, which silently froze the whole progress display.
    if (usage) setStorage(usage)
    if (!status || typeof status !== 'object') return

    if (status.file) {
      els.fileProgress.style.width = `${(status.file.progress * 100).toFixed(1)}%`
      const bits = [
        `${percent(status.file.progress)} of this file on disk`,
        `${bytes(status.file.downloaded)} / ${bytes(status.file.length)}`,
        status.file.done ? 'complete' : null,
        status.peers ? `${status.peers} peers` : 'no peers yet',
        status.downloadSpeed ? `${bytes(status.downloadSpeed)}/s` : null,
        status.timeRemaining ? `${clock(status.timeRemaining / 1000)} left` : null
      ].filter(Boolean)
      els.fileProgressText.textContent = bits.join(' · ')
      els.chipRatio.textContent = `file ${percent(status.file.progress)}`
      els.prepareBtn.disabled = !status.file.done
    }

    els.chipPeers.textContent = `peers ${status.peers}`
    els.chipSpeed.textContent = `↓ ${bytes(status.downloadSpeed)}/s`
    els.quotaWarn.classList.toggle('hidden', !status.quotaBlocked)

    // The timeline always shows the real movie length, taken from the server's
    // probe of the file header - never the browser's idea of a live stream's
    // duration, which is what made a 2:21 film look 18 seconds long.
    if (status.duration && !state.upgrading) {
      state.duration = status.duration
      state.playable = Number(status.playable) || 0
      updateTimeline()
      els.seekNote.textContent = state.nativeSeek
        ? ''
        : `downloaded to ${clock(state.playable)} — jumping ahead fetches that part on demand`
    }

    // Seekable-copy conversion is disabled: nothing ever sets status.prepare,
    // so there is no upgrade to apply. Kept as a guarded no-op so an old
    // in-flight job from before a restart cannot hijack playback.
    if (status.prepare?.state === 'running') {
      els.seekNote.textContent = `Downloaded - building a seekable copy…`
    }
  }

  state.events.onerror = () => { /* EventSource retries on its own */ }
}

/**
 * Swap the live stream for the finished faststart MP4.
 *
 * This is the moment the seek bar becomes real. The playhead is carried across so
 * the picture does not jump back to the start.
 */
function upgradeToSeekable () {
  if (state.upgrading || !state.playing) return
  state.upgrading = true
  // currentPosition(), not video.currentTime: on a live stream the element's clock
  // restarts at 0 for every stream, so using it would jump the film backwards.
  const at = currentPosition()
  const paused = els.video.paused
  const rungIndex = state.ladder.findIndex(rung => rung.mode === 'prepared')
  if (rungIndex !== -1) state.rung = rungIndex
  else state.ladder.push({ mode: 'prepared', label: 'Seekable' })
  startStream('prepared', { resumeAt: at })
  if (paused) els.video.pause()
  els.seekNote.textContent = ''
  toast('Download complete - the player can now seek.', 'ok')
}

/* --------------------------------------------------------------- actions -- */

els.closeTorrent.addEventListener('click', async () => {
  if (!state.id) return
  try {
    state.playing = false
    stopWatchdog()
    els.video.pause()
    els.video.removeAttribute('src')
    els.video.load()
    await api(`/api/torrents/${state.id}/close`, { method: 'POST' })
    state.events?.close()
    state.events = null
    state.id = null
    els.torrentCard.classList.add('hidden')
    els.playerCard.classList.add('hidden')
    renderLibrary()
    toast('Torrent closed. Downloaded data stays on disk.')
  } catch (error) {
    toast(explain(error), 'err')
  }
})

els.keepBtn.addEventListener('click', async () => {
  if (!state.id) return
  els.keepBtn.disabled = true
  try {
    await api(`/api/torrents/${state.id}/keep-full`, { method: 'POST', body: { fileIndex: Number(els.fileSelect.value) } })
    toast('Downloading the whole file — it will be kept in the data folder.', 'ok')
  } catch (error) {
    toast(explain(error), 'err')
  } finally {
    els.keepBtn.disabled = false
  }
})

els.prepareBtn.addEventListener('click', async () => {
  // Hidden by default — seekable copies are off (native on-demand playback).
  // The server also rejects this, so no background encoder can start.
  toast('Seekable-copy conversion is disabled. Set ENABLE_SEEKABLE_COPY=1 and restart to enable it.', 'err')
})

els.deleteBtn.addEventListener('click', async () => {
  if (!state.id) return
  if (!confirm('Delete this torrent\'s downloaded data from the data folder?')) return
  try {
    const result = await api(`/api/torrents/${state.id}`, { method: 'DELETE' })
    toast(`Deleted ${bytes(result.freed)} from disk.`, 'ok')
    setStorage({ bytes: result.usage, limitBytes: result.limitBytes })
    state.events?.close()
    state.events = null
    state.id = null
    state.playing = false
    stopWatchdog()
    els.video.pause()
    els.video.removeAttribute('src')
    els.video.load()
    els.torrentCard.classList.add('hidden')
    els.playerCard.classList.add('hidden')
    renderLibrary()
  } catch (error) {
    toast(explain(error), 'err')
  }
})

els.video.addEventListener('ended', async () => {
  state.playing = false
  stopWatchdog()
  if (!els.autodelete.checked || !state.id) {
    toast('Finished. The downloaded data is kept in your data folder.')
    return
  }
  try {
    const result = await api(`/api/torrents/${state.id}`, { method: 'DELETE' })
    toast(`Finished — deleted ${bytes(result.freed)} from disk.`, 'ok')
    setStorage({ bytes: result.usage, limitBytes: result.limitBytes })
    renderLibrary()
  } catch (error) {
    toast(explain(error), 'err')
  }
})

/* -------------------------------------------------------------- A/V sync -- */

/**
 * Shift the audio relative to the picture.
 *
 * Nothing here invents the offset: it exists because some releases are authored
 * slightly out of sync, and because Bluetooth and HDMI output add 150-300 ms of
 * latency that the browser does not compensate for. The element's audio is routed
 * through a Web Audio DelayNode so it can be nudged.
 *
 * The graph is only built when the control is first used, so audio is completely
 * untouched unless someone actually asks for a delay.
 */
const SYNC_STEP_MS = 50
const SYNC_LIMIT_MS = 5000
let audioGraph = null

function ensureAudioGraph () {
  if (audioGraph) return audioGraph
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) {
    els.syncNote.textContent = 'This browser cannot delay audio (no Web Audio support).'
    return null
  }
  try {
    const ctx = new Ctx()
    const source = ctx.createMediaElementSource(els.video)
    const delay = ctx.createDelay(10)
    const gain = ctx.createGain()
    source.connect(delay)
    delay.connect(gain)
    gain.connect(ctx.destination)
    audioGraph = { ctx, delay, gain }
    // The element's own volume is bypassed once its audio is tapped, so mirror it.
    applySyncVolume()
    els.syncNote.textContent = 'Audio is now routed through Web Audio for the delay.'
    return audioGraph
  } catch (error) {
    els.syncNote.textContent = `Could not set up audio delay: ${error.message}`
    return null
  }
}

function applySyncVolume () {
  if (!audioGraph) return
  audioGraph.gain.gain.value = els.video.muted ? 0 : els.video.volume
}

/** Apply the delay to the audio graph (no persistence). */
function applyAudioDelay (ms, { restart = true } = {}) {
  const clamped = Math.max(-SYNC_LIMIT_MS, Math.min(SYNC_LIMIT_MS, Math.round(ms / SYNC_STEP_MS) * SYNC_STEP_MS))
  state.audioDelayMs = clamped
  els.syncValue.textContent = `${clamped > 0 ? '+' : ''}${clamped} ms`
  els.syncNote.textContent = clamped < 0
    ? 'Audio earlier: needs the live converter to trim the audio. On native streams this value is remembered but not applied.'
    : ''

  if (clamped >= 0) {
    // Positive: hold the audio back in the graph (instant, no restart).
    if (clamped === 0 && !audioGraph) return // nothing routed, nothing to undo
    const graph = ensureAudioGraph()
    if (!graph) return
    graph.ctx.resume?.().catch(() => {})
    graph.delay.delayTime.value = clamped / 1000
  } else {
    // Negative: a DelayNode cannot advance audio — seeking the video forward
    // does not change the A/V offset at all. The live pipeline bakes it in
    // (`?audioDelay=`), so restart the stream with the new value.
    if (audioGraph) audioGraph.delay.delayTime.value = 0
    if (restart && state.playing && state.mode && !['prepared', 'direct', 'progressive'].includes(state.mode)) {
      startStream(state.mode, { resumeAt: currentPosition() })
    }
  }
}

/** User changed the delay: apply it and remember it for this file only. */
let syncSaveTimer = null
function setAudioDelay (ms) {
  applyAudioDelay(ms)
  clearTimeout(syncSaveTimer)
  syncSaveTimer = setTimeout(() => {
    if (!state.id) return
    api(`/api/torrents/${state.id}/sync`, {
      method: 'POST',
      body: { fileIndex: state.index, delayMs: state.audioDelayMs }
    }).catch(() => {})
  }, 600)
}

els.syncBtn.addEventListener('click', () => {
  const hidden = els.syncPanel.classList.toggle('gone')
  if (!hidden) {
    els.subsPanel.classList.add('gone')
    els.audioPanel.classList.add('gone')
    els.syncValue.textContent = `${state.audioDelayMs > 0 ? '+' : ''}${state.audioDelayMs || 0} ms`
    showControls()
  }
})
els.syncClose.addEventListener('click', () => els.syncPanel.classList.add('gone'))
els.syncMinus.addEventListener('click', () => setAudioDelay((state.audioDelayMs || 0) - SYNC_STEP_MS))
els.syncPlus.addEventListener('click', () => setAudioDelay((state.audioDelayMs || 0) + SYNC_STEP_MS))
els.syncReset.addEventListener('click', () => setAudioDelay(0))

// keep the Web Audio gain in step with the element's own controls
els.video.addEventListener('volumechange', applySyncVolume)
// Autoplay policies can leave the context suspended; the next interaction revives it.
document.addEventListener('click', () => { audioGraph?.ctx.resume?.().catch(() => {}) }, { passive: true })

/* ------------------------------------------------------------- subtitles -- */

const LANG3 = { eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt', dut: 'nl', nld: 'nl', pol: 'pl', rus: 'ru', ara: 'ar', hin: 'hi', tur: 'tr', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh' }
const srclang = language => {
  const code = String(language || '').toLowerCase()
  return LANG3[code] ?? (code ? code.slice(0, 2) : 'en')
}

function subsUrlFor (track) {
  const params = new URLSearchParams()
  const offset = Number(track.offsetMs) || 0
  const scale = Number(track.scale) || 1
  if (offset) params.set('offset', String(offset))
  if (scale !== 1) params.set('scale', String(scale))
  const qs = params.toString()
  return `/subs/${state.id}/${state.index}/${encodeURIComponent(track.id)}${qs ? `?${qs}` : ''}`
}

/**
 * Browsers only render WebVTT, and they only render tracks that exist as
 * <track> elements, so every track (embedded, bundled or downloaded) is added
 * to the video element and toggled through its TextTrack mode.
 *
 * Identity is the track *id*, never the display label: two tracks that share a
 * label ("eng") used to light up together, and the showing-mode lookup by
 * label missed whenever the browser normalized it. The element itself is
 * enabled once it has loaded — timing out at 300 ms used to leave tracks
 * permanently hidden on slower extractions.
 */
function applySubtitleTrack (track, { silent = false, persist = true } = {}) {
  const video = els.video
  // Drop whatever was showing before.
  for (const el of [...video.querySelectorAll('track')]) el.remove()
  for (const textTrack of video.textTracks) textTrack.mode = 'disabled'
  state.subtitle = track ? { ...track } : null
  state.activeSubtitle = track ? subsUrlFor(track) : null
  state.activeSubtitleId = track?.fileId != null ? String(track.fileId) : state.activeSubtitleId
  if (persist && state.id) {
    api(`/api/torrents/${state.id}/${state.index}/subtitles/select`, {
      method: 'POST',
      body: { trackId: track ? track.id : null }
    }).catch(() => {})
  }
  updateSubSyncUi()
  if (!track) return

  const el = document.createElement('track')
  el.kind = 'subtitles'
  // Unique label: kind + id, so identical language labels can never collide.
  el.label = `${track.kind || 'sub'} · ${track.id}`
  el.srclang = srclang(track.language)
  el.src = subsUrlFor(track)
  el.default = true
  video.appendChild(el)

  const enable = () => {
    const mine = video.textTracks[video.textTracks.length - 1]
    for (const textTrack of video.textTracks) textTrack.mode = textTrack === mine ? 'showing' : 'disabled'
  }
  el.addEventListener('load', enable)
  el.addEventListener('error', () => {
    if (state.subtitle?.id !== track.id) return
    toast('Could not load that subtitle track.', 'err')
    clearSubtitleTrack()
    if (state.subtitleTracks) renderSubtitleList(state.subtitleTracks)
  })
  // The track list is populated asynchronously; keep retrying until the
  // just-added track exists instead of guessing once and giving up.
  let tries = 0
  const poll = () => {
    if (state.subtitle?.id !== track.id) return
    if (video.textTracks.length > 0) enable()
    if (tries++ < 10 && video.textTracks.length === 0) setTimeout(poll, 250)
  }
  setTimeout(poll, 250)
  if (!silent) toast(`${track.label || 'Subtitle'} loaded.`, 'ok')
}

function clearSubtitleTrack () {
  for (const el of [...els.video.querySelectorAll('track')]) el.remove()
  for (const textTrack of els.video.textTracks) textTrack.mode = 'disabled'
  state.subtitle = null
  state.activeSubtitle = null
  state.activeSubtitleId = null
  updateSubSyncUi()
}

function findTrackById (id) {
  const data = state.subtitleTracks
  if (!data || !id) return null
  return [...(data.embedded || []), ...(data.bundled || []), ...(data.external || [])]
    .find(t => String(t.id) === String(id)) ?? null
}

function defaultSubtitleTrack () {
  const data = state.subtitleTracks
  if (!data) return null
  // Bundled sidecars match this exact release, so they win over embedded
  // copies and anything that would need downloading.
  const bundled = (data.bundled || []).find(t => normalizeLangClient(t.language) === 'en') || (data.bundled || [])[0]
  if (bundled) return bundled
  const embedded = (data.embedded || []).find(t => t.playable && t.default) || (data.embedded || []).find(t => t.playable)
  if (embedded) return embedded
  const external = (data.external || [])[0]
  return external ?? null
}

function normalizeLangClient (language) {
  const code = String(language || '').toLowerCase()
  return LANG3[code] ?? code
}

/** Re-apply the remembered choice after a fresh playback (or restore it). */
async function restoreSubtitleChoice () {
  try {
    await refreshSubtitleList({ quiet: true })
  } catch { return }
  const saved = state.savedSubtitle
  if (!saved) return
  if (saved.trackId === undefined) {
    // Never chosen: quietly enable the best built-in match.
    const track = defaultSubtitleTrack()
    if (track) applySubtitleTrack({ ...track, ...syncFor(track) }, { silent: true, persist: false })
    return
  }
  if (saved.trackId === null) return // explicitly Off
  const track = findTrackById(saved.trackId)
  if (track) applySubtitleTrack({ ...track, ...syncFor(track) }, { silent: true, persist: false })
}

function syncFor (track) {
  const syncs = state.subtitleTracks?.syncs ?? state.savedSubtitle?.syncs ?? {}
  return syncs[track.id] ?? { offsetMs: 0, scale: 1 }
}

async function openSubsPanel () {
  els.subsPanel.classList.remove('gone')
  showControls()
  await refreshSubtitleList()

  // Populate the list automatically and enable the best match, so the panel is
  // useful without having to search by hand - the full list stays available to
  // switch to another release.
  const data = state.subtitleTracks
  if (!data?.provider?.configured) return
  if (state.subtitleResults) {
    renderSubtitleResults(state.subtitleResults, state.subtitleQuery)
    return
  }
  await searchSubtitles({ silent: true, autoPick: true })
}

async function refreshSubtitleList ({ quiet = false } = {}) {
  if (!state.id) return
  if (!quiet) els.subsList.innerHTML = '<div class="subs-item"><span class="grow muted">Loading…</span></div>'
  try {
    const data = await api(`/api/torrents/${state.id}/${state.index}/subtitles`)
    state.subtitleTracks = data
    renderSubtitleList(data)
    if (state.subtitleResults) renderSubtitleResults(state.subtitleResults, state.subtitleQuery)
  } catch (error) {
    if (!quiet) els.subsList.innerHTML = `<div class="subs-item"><span class="grow muted">${error.message}</span></div>`
  }
}

function renderSubtitleList (data) {
  els.subsList.innerHTML = ''
  const activeId = state.subtitle?.id ?? null
  const isActive = track => activeId !== null && String(track.id) === String(activeId)

  const off = document.createElement('div')
  off.className = 'subs-item' + (!activeId ? ' active' : '')
  off.innerHTML = '<span class="grow">Off</span>'
  off.addEventListener('click', () => {
    clearSubtitleTrack()
    api(`/api/torrents/${state.id}/${state.index}/subtitles/select`, {
      method: 'POST', body: { trackId: null }
    }).catch(() => {})
    renderSubtitleList(data)
  })
  els.subsList.appendChild(off)

  const addTrackRow = (track, extra = '') => {
    const row = document.createElement('div')
    row.className = 'subs-item' + (isActive(track) ? ' active' : '') + (track.playable === false ? ' disabled' : '')
    const sync = syncFor(track)
    const syncNote = (sync.offsetMs || sync.scale !== 1)
      ? `<span class="tagline">${sync.offsetMs ? `${sync.offsetMs > 0 ? '+' : ''}${sync.offsetMs}ms` : ''}${sync.scale !== 1 ? (sync.offsetMs ? ' · ' : '') + `drift ×${sync.scale.toFixed(3)}` : ''}</span>` : ''
    const tag = [track.language, track.forced ? 'forced' : null, track.codec || extra].filter(Boolean).join(' · ')
    row.innerHTML = `<span class="grow">${escapeHtml(track.label || 'Track')}</span>`
      + `<span class="tagline">${escapeHtml(tag)}</span>` + syncNote
      + (track.playable === false ? '<span class="muted">bitmap</span>' : '')
    if (track.playable !== false) {
      row.addEventListener('click', () => {
        applySubtitleTrack({ ...track, ...syncFor(track) })
        renderSubtitleList(data)
      })
    }
    els.subsList.appendChild(row)
    return row
  }

  for (const track of data.embedded || []) addTrackRow(track)
  for (const track of data.bundled || []) addTrackRow(track, 'sidecar')

  for (const track of data.external || []) {
    const row = addTrackRow(track)
    const del = document.createElement('button')
    del.textContent = '✕'
    del.title = 'Remove'
    del.addEventListener('click', async event => {
      event.stopPropagation()
      await api(`/api/torrents/${state.id}/${state.index}/subtitles/${encodeURIComponent(track.id)}`, { method: 'DELETE' })
      if (activeId === track.id) clearSubtitleTrack()
      await refreshSubtitleList({ quiet: true })
    })
    row.appendChild(del)
  }

  if (!data.provider.configured) {
    els.subsStatus.textContent = data.provider.hint || 'Subtitle provider not configured.'
    els.subsSearchBtn.disabled = true
  } else {
    els.subsStatus.textContent = ''
    els.subsSearchBtn.disabled = false
  }
}

async function searchSubtitles ({ silent = false, autoPick = false } = {}) {
  if (!state.id) return
  if (!silent) els.subsResults.innerHTML = ''
  els.subsStatus.textContent = 'Searching…'
  try {
    const { query, results } = await api(`/api/torrents/${state.id}/${state.index}/subtitles/search`, {
      method: 'POST',
      body: { query: els.subsQuery.value.trim() || undefined, languages: [els.subsLang.value] }
    })
    els.subsQuery.placeholder = query || 'Search OpenSubtitles…'
    state.subtitleResults = results
    state.subtitleQuery = query

    if (!results.length) {
      els.subsStatus.textContent = 'No subtitles found.'
      return
    }
    renderSubtitleResults(results, query)

    // Default to the top match (ranked for this release) unless a subtitle is
    // already showing, one was already downloaded, or the torrent already
    // carries sidecars — those outrank any download.
    if (autoPick && !state.subtitle) {
      const builtIn = [...(state.subtitleTracks?.bundled ?? []), ...(state.subtitleTracks?.embedded ?? []).filter(t => t.playable)]
      if (builtIn.length) {
        const track = defaultSubtitleTrack()
        if (track) applySubtitleTrack({ ...track, ...syncFor(track) }, { silent: true, persist: false })
      } else {
        const alreadyHave = (state.subtitleTracks?.external ?? []).length > 0
        if (!alreadyHave) await pickSubtitle(results[0], { quiet: true })
      }
    }
  } catch (error) {
    els.subsStatus.textContent = error.message
    if (!silent) toast(error.message, 'err')
  }
}

function renderSubtitleResults (results, query) {
  els.subsStatus.textContent = `${results.length} result${results.length === 1 ? '' : 's'}`
    + (query ? ` for “${query}”` : '')
  els.subsResults.innerHTML = ''
  results.forEach((item, position) => {
    const row = document.createElement('div')
    const isActive = state.subtitle?.fileId != null && String(state.subtitle.fileId) === String(item.fileId)
    row.className = 'subs-item' + (isActive ? ' active' : '')
    const tag = [(item.language || '').toUpperCase(), item.hearingImpaired ? 'HI' : null,
      position === 0 ? 'best match' : null].filter(Boolean).join(' · ')
    row.innerHTML = `<span class="grow">${escapeHtml(item.release || item.fileName || 'subtitle')}</span>`
      + `<span class="tagline">${escapeHtml(tag)}</span>`
    const get = document.createElement('button')
    get.textContent = isActive ? '✓' : 'Use'
    get.disabled = isActive
    get.addEventListener('click', async event => {
      event.stopPropagation()
      get.disabled = true
      get.textContent = '…'
      try {
        await pickSubtitle(item)
      } catch (error) {
        toast(error.message, 'err')
      } finally {
        renderSubtitleResults(results, query)
      }
    })
    row.appendChild(get)
    els.subsResults.appendChild(row)
  })
}

/** Download one search result (if needed) and switch to it. */
async function pickSubtitle (item, { quiet = false } = {}) {
  const saved = await api(`/api/torrents/${state.id}/${state.index}/subtitles/fetch`, {
    method: 'POST',
    body: { fileId: item.fileId, language: item.language, label: item.release || item.fileName }
  })
  await refreshSubtitleList({ quiet: true })
  const track = findTrackById(saved.subtitle.id) ?? { kind: 'external', id: saved.subtitle.id, label: saved.subtitle.label, language: saved.subtitle.language, fileId: item.fileId }
  applySubtitleTrack({ ...track, fileId: item.fileId, ...syncFor(track) }, { silent: quiet })
  if (!quiet) toast('Subtitle loaded.', 'ok')
}

function escapeHtml (value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ))
}

/* --------------------------------------------------- subtitle timing knobs */

/** Drift presets mirror the server's list (frame-rate mismatch correction). */
const SUB_SYNC_SCALES = [
  { value: '1', label: 'Auto (1×)' },
  { value: String(24 / 23.976), label: '24 → 23.976 fps' },
  { value: String(23.976 / 24), label: '23.976 → 24 fps' },
  { value: String(25 / 24), label: '25 → 24 fps' },
  { value: String(24 / 25), label: '24 → 25 fps' }
]
for (const preset of SUB_SYNC_SCALES) {
  const option = document.createElement('option')
  option.value = preset.value
  option.textContent = preset.label
  els.subsyncScale.appendChild(option)
}

function updateSubSyncUi () {
  const track = state.subtitle
  const offset = Number(track?.offsetMs) || 0
  els.subsyncValue.textContent = `${offset > 0 ? '+' : ''}${offset} ms`
  els.subsyncScale.value = String(Number(track?.scale) || 1)
  els.subsyncMinus.disabled = !track
  els.subsyncPlus.disabled = !track
  els.subsyncReset.disabled = !track
  els.subsyncScale.disabled = !track
}

let subSyncTimer = null
function setSubOffset (ms) {
  const track = state.subtitle
  if (!track || !state.id) return
  const clamped = Math.max(-60000, Math.min(60000, Math.round(ms)))
  state.subtitle = { ...track, offsetMs: clamped }
  updateSubSyncUi()
  // The browser cannot nudge TextTrack cues, so the shift travels in the URL
  // and the track reloads at the same playhead with new cue timings.
  applySubtitleTrack(state.subtitle, { silent: true, persist: false })
  clearTimeout(subSyncTimer)
  subSyncTimer = setTimeout(() => {
    if (!state.id) return
    const { id, offsetMs, scale } = state.subtitle || {}
    if (!id) return
    api(`/api/torrents/${state.id}/${state.index}/subtitles/sync`, {
      method: 'POST', body: { trackId: id, offsetMs, scale }
    }).catch(() => {})
  }, 500)
}

els.subsyncMinus.addEventListener('click', () => setSubOffset((Number(state.subtitle?.offsetMs) || 0) - SUB_SYNC_STEP_MS))
els.subsyncPlus.addEventListener('click', () => setSubOffset((Number(state.subtitle?.offsetMs) || 0) + SUB_SYNC_STEP_MS))
els.subsyncReset.addEventListener('click', () => {
  if (!state.subtitle) return
  state.subtitle = { ...state.subtitle, offsetMs: 0, scale: 1 }
  setSubOffset(0)
})
els.subsyncScale.addEventListener('change', () => {
  const track = state.subtitle
  if (!track) return
  const scale = Number(els.subsyncScale.value) || 1
  state.subtitle = { ...track, scale }
  applySubtitleTrack(state.subtitle, { silent: true, persist: false })
  if (state.id) {
    api(`/api/torrents/${state.id}/${state.index}/subtitles/sync`, {
      method: 'POST', body: { trackId: track.id, offsetMs: state.subtitle.offsetMs || 0, scale }
    }).catch(() => {})
  }
})

const SUB_SYNC_STEP_MS = 50

els.subsBtn.addEventListener('click', () => {
  if (els.subsPanel.classList.contains('gone')) {
    els.syncPanel.classList.add('gone')   // the two panels share the same corner
    els.audioPanel.classList.add('gone')
    openSubsPanel()
  } else {
    els.subsPanel.classList.add('gone')
  }
})

els.audioBtn.addEventListener('click', () => {
  if (els.audioPanel.classList.contains('gone')) {
    els.syncPanel.classList.add('gone')
    els.subsPanel.classList.add('gone')
    renderAudioList()
    // Reveal the panel — without this the open branch only re-rendered a
    // display:none element, so the menu never actually appeared.
    els.audioPanel.classList.remove('gone')
    showControls()
  } else {
    els.audioPanel.classList.add('gone')
  }
})
els.audioClose.addEventListener('click', () => els.audioPanel.classList.add('gone'))

function renderAudioList () {
  const tracks = state.plan?.probe?.audios ?? []
  els.audioList.innerHTML = ''
  if (!tracks.length) {
    els.audioList.innerHTML = '<div class="subs-item"><span class="grow muted">No audio tracks found.</span></div>'
    return
  }
  tracks.forEach((track, index) => {
    // The implicit default is the first track; an explicit choice wins.
    const chosen = state.audioTrack == null ? index === 0 : state.audioTrack === track.streamIndex
    const row = document.createElement('div')
    row.className = 'subs-item' + (chosen ? ' active' : '')
    const tag = [track.language, track.channels != null ? `${track.channels}ch` : null, track.codec, track.default ? 'default' : null].filter(Boolean).join(' · ')
    row.innerHTML = `<span class="grow">${escapeHtml(track.title || track.language || `Track ${index + 1}`)}</span>`
      + `<span class="tagline">${escapeHtml(tag)}</span>`
    row.addEventListener('click', () => {
      state.audioTrack = index === 0 ? null : track.streamIndex
      const mode = state.mode === 'prepared' || state.mode === 'direct' || state.mode === 'progressive' ? 'auto' : state.mode
      startStream(mode, { resumeAt: currentPosition() })
      renderAudioList()
      els.audioPanel.classList.add('gone')
      if (index !== 0) toast(`Switched to audio track ${index + 1}`)
    })
    els.audioList.appendChild(row)
  })
}
els.subsClose.addEventListener('click', () => els.subsPanel.classList.add('gone'))
els.subsSearchBtn.addEventListener('click', () => searchSubtitles({ autoPick: true }))
els.subsQuery.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); searchSubtitles({ autoPick: true }) }
})
// Detect if the browser can decode HEVC/H.265 natively (macOS VideoToolbox,
// Windows with HEVC extensions, etc.). If so, the server can skip transcoding
// HEVC files and just remux them (copy), which is instant and uses zero CPU.
function detectHevcSupport () {
  try {
    const v = document.createElement('video')
    const r = v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"')
    return r === 'probably' || r === 'maybe'
  } catch { return false }
}

// Detect which audio codecs the browser can play natively.
// On macOS Chrome/Safari, AC-3 and E-AC-3 are often supported; on Windows
// it depends on the HEVC/AC-3 extensions. DTS is rarely supported in browsers.
function detectAudioCodecSupport () {
  const v = document.createElement('video')
  const check = mime => {
    try { return v.canPlayType(mime) === 'probably' || v.canPlayType(mime) === 'maybe' }
    catch { return false }
  }
  return {
    aac: true, // universally supported
    ac3: check('audio/mp4; codecs="ac-3"'),
    eac3: check('audio/mp4; codecs="ec-3"'),
    dts: check('audio/mp4; codecs="dtsc"') || check('audio/mp4; codecs="dtsh"'),
    opus: check('audio/ogg; codecs="opus"') || check('audio/webm; codecs="opus"'),
    flac: check('audio/mp4; codecs="flac"'),
    mp3: true, // universally supported
  }
}

const hevcSupported = detectHevcSupport()
const audioCodecs = detectAudioCodecSupport()

// Seed the search box with a cleaned-up version of the file name.
function seedSubtitleQuery () {
  if (!state.plan?.name) return
  els.subsQuery.value = String(state.plan.name)
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/\b(1080p|720p|2160p|x264|x265|hevc|web[- ]?dl|webrip|bluray|aac|10bit)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/* ------------------------------------------------------- playhead + pause -- */

/** Tell the server where we are, so it can bias the swarm at the playhead. */
let lastPlayheadPost = 0
function reportPlayhead (force = false) {
  if (!state.id) return
  const now = Date.now()
  if (!force && now - lastPlayheadPost < 2000) return
  lastPlayheadPost = now
  api(`/api/torrents/${state.id}/playhead`, {
    method: 'POST',
    body: { position: currentPosition(), duration: state.duration, paused: els.video.paused }
  }).catch(() => {})
}

// While paused, let the buffer settle for a moment and then close the pipeline
// entirely - a stopped player should not keep converting and pulling data.
let stopTimer = null
els.video.addEventListener('pause', () => {
  reportPlayhead(true)
  clearTimeout(stopTimer)
  stopTimer = setTimeout(() => {
    if (!els.video.paused || !state.id) return
    api(`/api/torrents/${state.id}/stop-download`, { method: 'POST' })
      .then(() => { state.streamClosed = true })
      .catch(() => {})
  }, 6000)
})

els.video.addEventListener('play', () => {
  clearTimeout(stopTimer)
  reportPlayhead(true)
  // The pipeline was closed while we were stopped: reopen exactly where we are.
  if (state.streamClosed) {
    state.streamClosed = false
    const at = currentPosition()
    if (!state.nativeSeek) startStream(state.mode, { resumeAt: at })
  }
})

els.video.addEventListener('timeupdate', () => reportPlayhead())

/* ------------------------------------------------------- resume positions -- */

els.video.addEventListener('timeupdate', () => {
  if (!state.id || !state.playing) return
  const now = Date.now()
  if (now - state.lastSaved < 15000) return
  state.lastSaved = now
  savePosition()
})

function savePosition () {
  if (!state.id || !state.duration) return
  api(`/api/library/${state.id}/position`, {
    method: 'POST',
    body: {
      // Real movie time, and the real runtime - not the live stream's own
      // (meaningless) duration, which is what used to be stored here.
      position: currentPosition(),
      duration: state.duration,
      fileIndex: state.index
    }
  }).catch(() => {})
}

window.addEventListener('beforeunload', () => {
  if (!state.id || !state.duration) return
  try {
    navigator.sendBeacon(
      `/api/library/${state.id}/position`,
      new Blob([JSON.stringify({
        position: currentPosition(),
        duration: state.duration,
        fileIndex: state.index
      })], { type: 'application/json' })
    )
  } catch { /* ignore */ }
})

/* ---------------------------------------------------------------- library -- */

async function renderLibrary () {
  try {
    const { items, usage } = await api('/api/library')
    setStorage(usage)
    els.libraryList.innerHTML = ''
    els.libraryEmpty.classList.toggle('hidden', items.length > 0)
    els.librarySummary.textContent = items.length
      ? `${items.length} item${items.length === 1 ? '' : 's'} · ${bytes(usage.bytes)} on disk`
      : '—'

    for (const item of items) {
      const li = document.createElement('li')

      const info = document.createElement('div')
      info.className = 'info'
      const name = document.createElement('div')
      name.className = 'name'
      name.textContent = item.name || item.infoHash
      const sub = document.createElement('div')
      sub.className = 'sub'
      const resume = item.resume?.position > 15 ? ` · resume ${clock(item.resume.position)}` : ''
      sub.textContent = `${bytes(item.onDiskBytes ?? 0)} on disk / ${bytes(item.length ?? 0)}${resume}${item.prepared ? ' · seekable' : ''}`
      info.append(name, sub)

      const play = document.createElement('button')
      play.className = 'ghost'
      play.textContent = 'Play'
      play.disabled = !item.hasTorrentFile
      play.addEventListener('click', () => openFromLibrary(item))

      const del = document.createElement('button')
      del.className = 'ghost danger'
      del.textContent = 'Delete'
      del.addEventListener('click', () => deleteFromLibrary(item))

      li.append(info, play, del)
      els.libraryList.appendChild(li)
    }
  } catch (error) {
    els.librarySummary.textContent = 'library unavailable'
  }
}

async function openFromLibrary (item) {
  try {
    toast('Opening from disk…')
    const data = await api(`/api/library/${item.infoHash}/open`, { method: 'POST' })
    state.id = data.id
    state.infoHash = data.id
    state.name = data.name
    state.files = data.files
    renderTorrent({ ...data, allFileCount: data.files.length })
    els.magnet.value = ''
    renderLibrary()

    const fileIndex = item.resume?.fileIndex ?? Number(els.fileSelect.value)
    els.fileSelect.value = String(fileIndex)
    await startPlayback(fileIndex)

    const resume = item.resume
    if (resume?.position > 15) {
      const mode = state.ladder[state.rung]?.mode
      if (mode === 'direct' || mode === 'prepared') {
        els.video.addEventListener('loadedmetadata', () => {
          els.video.currentTime = resume.position
          toast(`Resumed at ${clock(resume.position)}`)
        }, { once: true })
      }
    }
  } catch (error) {
    toast(explain(error), 'err')
  }
}

async function deleteFromLibrary (item) {
  if (!confirm(`Delete “${item.name}” and its downloaded data?`)) return
  try {
    const result = await api(`/api/library/${item.infoHash}`, { method: 'DELETE' })
    toast(`Freed ${bytes(result.freed)}.`, 'ok')
    setStorage({ bytes: result.usage, limitBytes: result.limitBytes })
    if (state.id === item.infoHash) {
      state.id = null
      state.playing = false
      els.torrentCard.classList.add('hidden')
      els.playerCard.classList.add('hidden')
      els.video.pause()
      els.video.removeAttribute('src')
      els.video.load()
    }
    renderLibrary()
  } catch (error) {
    toast(explain(error), 'err')
  }
}

/* -------------------------------------------------------------------- boot */

loadHealth()
renderLibrary()
setInterval(renderLibrary, 20000)
