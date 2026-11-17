import { spawn } from 'node:child_process'

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'

/**
 * The shared tail of every ffmpeg pipeline.
 *
 * Output is always fragmented MP4, because that is the only MP4 flavour that can
 * be streamed while it is still being produced: `empty_moov` writes the
 * initialization segment up front, `frag_keyframe` emits a playable fragment at
 * every keyframe. `-tune zerolatency` (no B-frames, no lookahead) keeps encoder
 * delay to a few frames so the browser can start seconds after the first bytes.
 *
 * `seekableOutput` switches to a real file with `+faststart`, which moves the
 * moov atom to the front - that variant is fully seekable over HTTP Range.
 */
/**
 * Encoding presets.
 *
 * A live stream must encode FASTER than realtime or the player starves - measured
 * on a 1080p source, veryfast manages ~2.4x and ultrafast ~3.7x. Headroom is what
 * stops buffering, so the streaming paths use ultrafast.
 *
 * A one-off conversion to a file has no such deadline, so it keeps the slower,
 * better-looking preset.
 */
export const LIVE_PRESET = process.env.TRANSCODE_PRESET || 'ultrafast'
export const FILE_PRESET = process.env.PREPARE_PRESET || 'veryfast'

/**
 * Hardware decoding, where available.
 *
 * Decoding a high-bitrate stream in software costs CPU that the encoder then does
 * not get. Measured on a 12 Mbps 1080p HEVC source, `-hwaccel videotoolbox` took
 * the transcode from 10.9x to 16.4x realtime. Only seekable inputs (a file or an
 * HTTP source) have a hardware path here; a pipe does not.
 */
export const HWACCEL = process.env.HWACCEL || 'videotoolbox'
export const HWACCEL_ENABLED = process.env.DISABLE_HWACCEL !== '1'

function hwaccelArgs () {
  return HWACCEL_ENABLED ? ['-hwaccel', HWACCEL] : []
}

export function outputArgs ({ videoCopy, audioCopy, seekableOutput = false, preset = FILE_PRESET, maxBitrateKbps = 0, crf = 21, audioStreamIndex = null, audioDelayMs = 0 }) {
  // `audioStreamIndex` is the ffprobe stream index the caller wants for audio.
  // null keeps the historical behaviour of the first audio track.
  const audioMap = audioStreamIndex == null ? '0:a:0?' : `0:${audioStreamIndex}`
  const args = ['-map', '0:v:0?', '-map', audioMap, '-sn', '-dn']
  // A delay cannot be expressed with a stream copy; the audio has to be
  // re-encoded for the filter to run. That only happens when a delay is set.
  const offsetAudio = Number(audioDelayMs) || 0
  const copyAudio = audioCopy && offsetAudio === 0

  if (videoCopy) {
    args.push('-c:v', 'copy')
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', preset,
      '-tune', 'zerolatency',
      '-crf', String(crf),
      '-pix_fmt', 'yuv420p',
      '-g', '48',
      '-keyint_min', '48',
      '-sc_threshold', '0',
      '-threads', '4'
    )
    // A fast preset is far less efficient per bit, so a bare CRF can produce a file
    // several times the size of the source. Capping the rate keeps the copy within
    // the same order of magnitude as the film it came from.
    if (maxBitrateKbps > 0) {
      args.push('-maxrate', `${maxBitrateKbps}k`, '-bufsize', `${maxBitrateKbps * 2}k`)
    }
  }

  if (audioCopy) args.push('-c:a', 'copy')
  else args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2')

  // A/V offset for the live pipeline. Browser-only delay nodes cannot advance
  // audio (negative), so negative values are baked in here by trimming the
  // audio start; positive values delay it by inserting silence.
  // NOTE: This is disabled by default to avoid sync issues. The A/V button
  // handles sync via Web Audio (positive delays only).
  // if (offsetAudio > 0) {
  //   args.push('-af', `adelay=${Math.round(offsetAudio)}:all=1`)
  // } else if (offsetAudio < 0) {
  //   args.push('-af', `atrim=start=${(Math.abs(offsetAudio) / 1000).toFixed(3)},asetpts=PTS-STARTPTS`)
  // }

  if (seekableOutput) {
    // The partial file is written as "<name>.mp4.part", so the muxer has to be
    // named explicitly - ffmpeg cannot infer it from that extension.
    args.push('-movflags', '+faststart', '-f', 'mp4')
  } else {
    args.push(
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration', '1000000',
      '-f', 'mp4'
    )
  }

  args.push('-max_muxing_queue_size', '10240')
  return args
}

/**
 * ffmpeg reading a torrent stream on stdin, writing a live fMP4 stream on stdout.
 *
 * `-ss` goes *after* `-i` here: a pipe cannot be seeked, so this is decode-and-
 * discard. That costs a moment of CPU proportional to the jump (trivial for the
 * ±10s buttons, slower for a big scrub) but always lands on the right frame and
 * keeps streaming to the end without needing an index.
 */
export function streamArgs ({ videoCopy, audioCopy, startAt, audioStreamIndex, audioDelayMs = 0 }) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', 'pipe:0',
    ...(startAt > 0 ? ['-ss', String(startAt)] : []),
    ...outputArgs({ videoCopy, audioCopy, preset: LIVE_PRESET, audioStreamIndex, audioDelayMs }),
    'pipe:1'
  ]
}

/** From a file on disk: input seek is exact and instant, so `-ss` goes first. */
export function fileStreamArgs ({ inputPath, videoCopy, audioCopy, startAt, audioStreamIndex, audioDelayMs = 0 }) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...(startAt > 0 ? ['-ss', String(startAt)] : []),
    '-i', inputPath,
    ...outputArgs({ videoCopy, audioCopy, preset: LIVE_PRESET, audioStreamIndex, audioDelayMs }),
    'pipe:1'
  ]
}

/**
 * From the range-serving HTTP endpoint (the torrent's own bytes).
 *
 * This is how a seek must work on a partially downloaded file: a local file with
 * missing pieces reads back as zeros, so ffmpeg decodes garbage and never finds a
 * picture. Reading over HTTP instead means every seek turns into a Range request,
 * and the server answers it by fetching exactly those pieces and holding the
 * connection until they arrive - so ffmpeg always sees correct bytes.
 *
 * `-seekable 1` tells ffmpeg it may seek this input, which is what makes `-ss`
 * land on a real keyframe instead of scanning from the beginning.
 */
export function urlStreamArgs ({ inputUrl, videoCopy, audioCopy, startAt, audioStreamIndex, audioDelayMs = 0 }) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-seekable', '1',
    '-rw_timeout', String(Number(process.env.HTTP_INPUT_TIMEOUT_US || 60000000)),
    ...(startAt > 0 ? ['-ss', String(startAt)] : []),
    '-i', inputUrl,
    ...outputArgs({ videoCopy, audioCopy, preset: LIVE_PRESET, audioStreamIndex, audioDelayMs }),
    'pipe:1'
  ]
}

/** Produce a seekable, faststart MP4 on disk (used by the "prepare" feature). */
export function fileArgs ({ inputPath, outputPath, videoCopy, audioCopy, progress = false, preset = FILE_PRESET, maxBitrateKbps = 0, crf = 21, audioStreamIndex = null }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...hwaccelArgs(), '-i', inputPath]
  // -progress must be given before the output it describes.
  if (progress) args.push('-progress', 'pipe:2', '-nostats')
  args.push(...outputArgs({ videoCopy, audioCopy, seekableOutput: true, preset, maxBitrateKbps, crf, audioStreamIndex }), outputPath)
  return args
}

/** Spawn ffmpeg and keep a bounded stderr tail so failures can be explained. */
export function spawnFfmpeg (args) {
  const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', chunk => {
    stderr = (stderr + chunk).slice(-8000)
  })
  return {
    proc,
    getStderr: () => stderr.trim(),
    kill () {
      try { proc.kill('SIGKILL') } catch { /* already gone */ }
    }
  }
}
