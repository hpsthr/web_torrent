import fs from 'node:fs'
import path from 'node:path'
import { FFMPEG, fileArgs } from './ffmpeg.js'

/**
 * Where a seekable copy of a torrent file lives.
 *
 * Remuxing/transcoding a torrent stream produces a *live* stream: playable the
 * instant the first fragments arrive, but impossible to scrub through, because
 * nothing is seekable end to end. Once the download has finished we can redo the
 * same conversion against the file on disk and write a normal faststart MP4.
 * After that, playback and seeking are plain HTTP Range reads - no ffmpeg, no
 * peers, works offline.
 */
export function preparedFilePath ({ dataDir, infoHash, fileIndex }) {
  return path.join(dataDir, '.seekable', infoHash, `${fileIndex}.mp4`)
}

export function preparedDir ({ dataDir, infoHash }) {
  return path.join(dataDir, '.seekable', infoHash)
}

/**
 * Run the conversion in the background, reporting progress as a 0..1 fraction.
 * Output is written to a `.part` file and renamed on success, so an interrupted
 * run can never look like a finished one.
 */
export function startPrepare ({ inputPath, outputPath, plan, preset = null, maxBitrateKbps = 0, crf = 21, duration, onProgress = () => {}, onDone = () => {}, onFail = () => {}, log = () => {} }) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const partial = `${outputPath}.part`

  const args = fileArgs({
    inputPath,
    outputPath: partial,
    videoCopy: plan.videoCopy,
    audioCopy: plan.audioCopy,
    progress: true,
    maxBitrateKbps,
    crf,
    ...(preset ? { preset } : {})
  })

  log(`preparing seekable copy: ffmpeg ${args.join(' ')}`)
  const proc = require$spawn(FFMPEG, args)

  let stderrTail = ''
  let lastProgress = 0

  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk).slice(-4000)
    const match = /out_time_us=(\d+)|out_time_ms=(\d+)/g
    let hit
    while ((hit = match.exec(chunk)) !== null) {
      const micros = Number(hit[1] ?? hit[2])
      if (!Number.isFinite(micros) || !duration) continue
      const fraction = Math.max(0, Math.min(1, micros / 1e6 / duration))
      if (fraction - lastProgress > 0.01) {
        lastProgress = fraction
        onProgress(fraction)
      }
    }
  })

  let killed = false
  proc.on('error', err => {
    if (!killed) onFail(err.message)
  })
  proc.on('exit', code => {
    if (killed) return
    if (code === 0) {
      try {
        fs.renameSync(partial, outputPath)
        onDone({ path: outputPath, size: fs.statSync(outputPath).size })
      } catch (err) {
        onFail(`could not finalize prepared file: ${err.message}`)
      }
    } else {
      fs.rmSync(partial, { force: true })
      onFail(stderrTail.trim() || `ffmpeg exited with code ${code}`)
    }
  })

  return {
    kill () {
      killed = true
      try { proc.kill('SIGKILL') } catch { /* already gone */ }
      fs.rmSync(partial, { force: true })
    },
    // SIGSTOP/SIGCONT lets us freeze a background encode so a live playback
    // keeps the CPU; resuming continues the file from where it stopped, so a
    // paused stretch is lost time, never progress.
    pause () { try { proc.kill('SIGSTOP') } catch { /* already gone */ } },
    resume () { try { proc.kill('SIGCONT') } catch { /* already gone */ } }
  }
}

// Kept local so this module has no import-time coupling to child_process naming.
import { spawn as require$spawn } from 'node:child_process'
