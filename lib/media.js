/**
 * Container + codec rules.
 *
 * Two independent questions decide how a file is delivered to the browser:
 *
 *   1. CONTAINER - can Chromium demux it at all? (mp4/mov/webm: yes; mkv/avi: no)
 *   2. CODECS    - can Chromium decode the streams inside?
 *                  Only 8-bit 4:2:0 H.264 and AAC are universally safe.
 *                  Hi10P anime encodes, HEVC, MPEG-4 Part 2 (DivX/XviD in .avi)
 *                  and AC-3/DTS audio all need a real re-encode.
 *
 * Answering both lets us skip ffmpeg entirely when possible (zero CPU, zero
 * quality loss) and only pay for an encode when it is actually required.
 */

export const VIDEO_EXTENSIONS = new Set([
  'mkv', 'mp4', 'm4v', 'webm', 'mov', 'avi', 'divx', 'mpg', 'mpeg',
  'm2ts', 'mts', 'ts', 'flv', 'wmv', 'asf', 'ogv', 'ogm', 'rm', 'rmvb',
  'vob', '3gp', 'f4v', 'mxf'
])

/** Containers the browser can demux on its own; everything else goes to ffmpeg. */
const DIRECT_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm'])

/** Text subtitle sidecars that ship *inside* a torrent next to the video. */
export const SUBTITLE_EXTENSIONS = new Set(['srt', 'vtt', 'ass', 'ssa'])

const MIME_BY_EXT = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
  ogv: 'video/ogg'
}

// Browsers decode 8-bit 4:2:0 H.264 only. Hi10P (yuv420p10le) silently fails.
const SAFE_VIDEO_CODECS = new Set(['h264'])
const SAFE_PIX_FMTS = new Set(['yuv420p', 'yuvj420p'])
const SAFE_AUDIO_CODECS = new Set(['aac'])

export function extensionOf (name = '') {
  const base = String(name).split(/[?#]/)[0]
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase()
}

export function isVideoFile (name) {
  return VIDEO_EXTENSIONS.has(extensionOf(name))
}

export function isSubtitleFile (name) {
  return SUBTITLE_EXTENSIONS.has(extensionOf(name))
}

export function isDirectContainer (name) {
  return DIRECT_CONTAINERS.has(extensionOf(name))
}

export function mimeOf (name) {
  return MIME_BY_EXT[extensionOf(name)] || 'application/octet-stream'
}

export function isBrowserSafeVideo (stream, { hevcSupported = false } = {}) {
  if (!stream) return false
  if (SAFE_VIDEO_CODECS.has(stream.codec)) return SAFE_PIX_FMTS.has(stream.pixFmt)
  // HEVC is safe when the browser can decode it (macOS VideoToolbox, Windows HEVC ext).
  if (hevcSupported && stream.codec === 'hevc') return SAFE_PIX_FMTS.has(stream.pixFmt)
  return false
}

export function isBrowserSafeAudio (stream, { audioCodecs = {} } = {}) {
  if (!stream) return false
  // AAC is universally safe. Other codecs (AC-3, E-AC-3, DTS, Opus, FLAC) are
  // re-encoded to AAC on the live path to guarantee A/V sync — copying them
  // preserves the source timestamps which can drift in fragmented MP4.
  return SAFE_AUDIO_CODECS.has(stream.codec)
}

/**
 * @param {{ fileName: string, probe: null | { video: object|null, audio: object|null } }} input
 * @returns {{ mode: 'direct'|'remux'|'transcode', videoCopy: boolean, audioCopy: boolean, reason: string }}
 */
export function planPlayback ({ fileName, probe, hevcSupported = false, audioCodecs = {} }) {
  const ext = extensionOf(fileName) || 'file'
  const directContainer = isDirectContainer(fileName)
  const codecsKnown = Boolean(probe && probe.video)
  const videoSafe = isBrowserSafeVideo(probe?.video, { hevcSupported })
  const audioSafe = isBrowserSafeAudio(probe?.audio, { audioCodecs })

  // Native path: the browser gets raw bytes over HTTP Range and does everything
  // itself. A non-faststart MP4 cannot take this path directly - its moov atom
  // sits at the very end, so the browser has no index, no duration and no working
  // seek bar. Those are repaired instead: the index is relocated to the front and
  // served as an ordinary faststart MP4 (see lib/mp4.js).
  const needsIndex = directContainer && probe?.faststart === false
  if (directContainer && needsIndex && (!codecsKnown || (videoSafe && audioSafe))) {
    return {
      mode: 'progressive',
      videoCopy: true,
      audioCopy: true,
      reason: `.${ext} has its index at the end - moving it to the front so it streams and seeks natively`
    }
  }

  if (directContainer && !needsIndex && (!codecsKnown || (videoSafe && audioSafe))) {
    return {
      mode: 'direct',
      videoCopy: true,
      audioCopy: true,
      reason: codecsKnown
        ? `${probe.video.codec}${probe.audio ? ` + ${probe.audio.codec}` : ''} in .${ext} - browser plays it natively`
        : `.${ext} is natively supported - serving raw bytes`
    }
  }

  // Codec probing failed (odd header layout). Re-encode rather than risk a black screen.
  if (!codecsKnown) {
    return {
      mode: 'transcode',
      videoCopy: false,
      audioCopy: false,
      reason: `.${ext}: could not identify codecs, re-encoding to guarantee playback`
    }
  }

  const label = `${probe.video.codec} ${probe.video.pixFmt || ''}`.trim() +
    (probe.audio ? ` + ${probe.audio.codec}` : '')

  // Container swap only: stream copy, ~0% CPU, no re-encode, no quality loss.
  if (videoSafe && audioSafe) {
    return {
      mode: 'remux',
      videoCopy: true,
      audioCopy: true,
      reason: needsIndex
        ? `.${ext} has its index at the end - remuxing to a seekable fragmented MP4`
        : `${label} is browser-safe - remuxing .${ext} to fragmented MP4 (no re-encode)`
    }
  }

  // Re-encode only the streams that are actually unsafe (a DTS track should not
  // force a full video re-encode).
  const parts = []
  if (!videoSafe) parts.push(`${probe.video.codec}${probe.video.pixFmt ? `/${probe.video.pixFmt}` : ''} video`)
  if (probe.audio && !audioSafe) parts.push(`${probe.audio.codec} audio`)
  return {
    mode: 'transcode',
    videoCopy: videoSafe,
    audioCopy: audioSafe,
    reason: `${parts.join(' + ')} not browser-safe - re-encoding${videoSafe ? ' audio only' : ''}`
  }
}
