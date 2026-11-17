/**
 * Can this browser actually decode HEVC?
 *
 *   node test/codec-probe.mjs <video-file>
 *
 * Serves the file, loads it in headless Chrome and reports whether the media
 * element decoded it (readyState + dimensions) or errored. Used to decide whether
 * a codec needs re-encoding at all on this machine.
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = process.argv[2]
if (!file || !fs.existsSync(file)) {
  console.error('usage: node test/codec-probe.mjs <video-file>')
  process.exit(1)
}

const PORT = 9399
const DEBUG_PORT = 9398
const sleep = ms => new Promise(r => setTimeout(r, ms))

const server = http.createServer((req, res) => {
  const stat = fs.statSync(file)
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    const start = m[1] ? Number(m[1]) : 0
    const end = m[2] ? Number(m[2]) : stat.size - 1
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes'
    })
    fs.createReadStream(file, { start, end }).pipe(res)
  } else {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' })
    fs.createReadStream(file).pipe(res)
  }
})
await new Promise(r => server.listen(PORT, '127.0.0.1', r))

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--no-first-run', '--mute-audio',
  ...(process.env.USE_GPU ? [] : ['--disable-gpu']),
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--user-data-dir=/tmp/webtorent-codec-profile',
  'about:blank'
], { stdio: 'ignore' })

async function target () {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find(t => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch { /* not up */ }
    await sleep(250)
  }
  throw new Error('chrome never started')
}

const page = await target()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data)
  const p = pending.get(msg.id)
  if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result) }
}
const send = (method, params = {}) => {
  const n = ++id
  ws.send(JSON.stringify({ id: n, method, params }))
  return new Promise((res, rej) => pending.set(n, { res, rej }))
}
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: 'about:blank' })
await sleep(500)

const result = await evaluate(`(async () => {
  const v = document.createElement('video')
  v.muted = true
  v.src = 'http://127.0.0.1:${PORT}/media.mp4'
  document.body.appendChild(v)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  await wait(4000)
  let played = false
  try { await v.play(); played = true } catch (e) { played = 'blocked: ' + e.message }
  await wait(3000)
  return JSON.stringify({
    readyState: v.readyState,
    networkState: v.networkState,
    videoWidth: v.videoWidth,
    videoHeight: v.videoHeight,
    duration: v.duration,
    currentTime: Number(v.currentTime.toFixed(2)),
    played,
    error: v.error ? { code: v.error.code, message: v.error.message } : null,
    canPlayHevc: v.canPlayType('video/mp4; codecs="hvc1"') || '(empty)'
  }, null, 2)
})()`)

console.log(result)
chrome.kill('SIGKILL')
server.close()
process.exit(0)
