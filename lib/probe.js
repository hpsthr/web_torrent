import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { describeSubtitleStreams } from './subtitles.js'

const execFileAsync = promisify(execFile)

let toolchainPromise = null

/** Detect ffmpeg/ffprobe once, cache the result for the process lifetime. */
export function toolchain () {
  if (!toolchainPromise) {
    toolchainPromise = (async () => {
      let ffmpeg = false
      let ffprobe = false
      let version = null
      try {
        const { stdout } = await execFileAsync('ffmpeg', ['-version'], { timeout: 15000 })
        ffmpeg = true
        version = stdout.split('\n')[0].trim()
      } catch { /* not installed */ }
      try {
        await execFileAsync('ffprobe', ['-version'], { timeout: 15000 })
        ffprobe = true
      } catch { /* not installed */ }
      return { ffmpeg, ffprobe, version }
    })()
  }
  return toolchainPromise
}

export async function probeInput (input, { timeout = 45000 } = {}) {
  const args = ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', '-i', input]
  const { stdout } = await execFileAsync('ffprobe', args, { timeout, maxBuffer: 16 << 20 })
  return JSON.parse(stdout)
}

export function summarizeProbe (json) {
  const streams = Array.isArray(json?.streams) ? json.streams : []
  const video = streams.find(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
  const audio = streams.find(s => s.codec_type === 'audio')
  return {
    // Subtitle tracks already inside the file - these need no provider.
    subtitles: describeSubtitleStreams(streams),
    duration: Number(json?.format?.duration) || 0,
    container: json?.format?.format_name ?? null,
    video: video
      ? {
          codec: video.codec_name,
          pixFmt: video.pix_fmt ?? null,
          width: video.width ?? null,
          height: video.height ?? null,
          profile: video.profile ?? null
        }
      : null,
    audio: audio
      ? {
          codec: audio.codec_name,
          channels: audio.channels ?? null,
          sampleRate: audio.sample_rate ?? null
        }
      : null,
    // Every audio track, so the player can offer switching. `streamIndex` is the
    // absolute index ffprobe reports, which is what an ffmpeg `-map 0:N` needs.
    audios: streams
      .filter(s => s.codec_type === 'audio')
      .map((s, i) => {
        const tags = s.tags ?? {}
        const disposition = s.disposition ?? {}
        return {
          // Position among audio tracks only (0:a:N); kept for anything that
          // still thinks in per-type ordinals.
          track: i,
          streamIndex: s.index,
          codec: s.codec_name,
          channels: s.channels ?? null,
          sampleRate: s.sample_rate ?? null,
          language: (tags.language ?? '').toLowerCase() || null,
          title: tags.title ?? null,
          default: disposition.default === 1
        }
      })
  }
}

/**
 * Probe a torrent file by pulling only its first few MB.
 *
 * MKV/AVI/MP4 all carry the track headers at the start, so a small head read is
 * enough to learn the codecs. Side benefit: this warms the first pieces of the
 * file, which is exactly the data the player needs a moment later.
 *
 * Never throws - returns null when the header cannot be read (e.g. no peers yet)
 * so callers can fall back to a conservative strategy.
 */
export async function probeTorrentHead (file, { maxBytes = 6 << 20, tmpDir, timeoutMs = 40000, log = () => {} } = {}) {
  const end = Math.min(maxBytes, file.length) - 1
  const chunks = []
  let size = 0
  const stream = file.createReadStream({ start: 0, end })
  const timer = setTimeout(() => stream.destroy(new Error('probe timed out')), timeoutMs)

  try {
    for await (const chunk of stream) {
      chunks.push(chunk)
      size += chunk.length
      if (size >= maxBytes) break
    }
  } catch (err) {
    log(`probe unavailable: ${err.message}`)
    return null
  } finally {
    clearTimeout(timer)
    stream.destroy()
  }

  const tmp = path.join(tmpDir, `probe-${crypto.randomUUID()}.bin`)
  try {
    await fs.writeFile(tmp, Buffer.concat(chunks, size))
    return summarizeProbe(await probeInput(tmp))
  } catch (err) {
    log(`probe failed: ${err.message}`)
    return null
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}
