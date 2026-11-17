/**
 * Watches playback health over time in a real browser.
 *
 *   node test/buffer-watch.mjs [infoHash] [seconds]
 *
 * Plays a library item and samples the buffer, stalls and the on-screen clock, so
 * "it buffers" can be measured instead of guessed. Reports every `waiting` event,
 * which is what the player surfaces as "buffering…".
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9334
const APP = process.env.APP_URL || 'http://127.0.0.1:5173'
const SECONDS = Number(process.argv[3] || 40)

async function resolveTarget () {
  if (process.argv[2]) return process.argv[2]
  const res = await fetch(`${APP}/api/library`)
  const { items } = await res.json()
  if (!items.length) { console.error('library is empty'); process.exit(1) }
  console.log(`item: ${items[0].name}`)
  return items[0].infoHash
}

const infoHash = await resolveTarget()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/webtorent-buffer-profile',
  'about:blank'
], { stdio: 'ignore' })

async function page () {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find(t => t.type === 'page')
      if (p?.webSocketDebuggerUrl) return p
    } catch { /* not up */ }
    await sleep(250)
  }
  throw new Error('chrome never started')
}

const target = await page()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
ws.onmessage = ev => {
  const m = JSON.parse(ev.data)
  const p = pending.get(m.id)
  if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) }
}
const send = (method, params = {}) => {
  const n = ++id
  ws.send(JSON.stringify({ id: n, method, params }))
  return new Promise((res, rej) => pending.set(n, { res, rej }))
}
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
  return r.result.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: APP })
await sleep(2500)

const report = await evaluate(`(async () => {
  const out = []
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const IH = ${JSON.stringify(infoHash)}

  const rows = [...document.querySelectorAll('#library-list li')]
  const row = rows[0]
  const play = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === 'Play')
  play.click()
  await wait(6000)

  const v = document.getElementById('video')
  let waits = 0, stalls = 0
  v.addEventListener('waiting', () => { waits++ })
  v.addEventListener('stalled', () => { stalls++ })

  const buffered = () => {
    try {
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= v.currentTime && v.currentTime <= v.buffered.end(i)) {
          return v.buffered.end(i) - v.currentTime
        }
      }
    } catch {}
    return 0
  }

  const t0 = Date.now()
  let lastTime = v.currentTime
  while (Date.now() - t0 < ${SECONDS * 1000}) {
    await wait(2000)
    const advanced = v.currentTime - lastTime
    lastTime = v.currentTime
    out.push('  t+' + String(Math.round((Date.now() - t0) / 1000)).padStart(3) + 's'
      + '  pos=' + document.getElementById('time-now').textContent
      + '  buffer=' + buffered().toFixed(1) + 's'
      + '  readyState=' + v.readyState
      + '  played=' + advanced.toFixed(1) + 's/2s'
      + (advanced < 1.2 ? '   <-- STALLED' : ''))
  }
  out.unshift('mode: ' + document.getElementById('chip-mode').textContent)
  out.push('waiting events: ' + waits + '   stalled events: ' + stalls)
  return out.join('\\n')
})()`)

console.log(report)
chrome.kill('SIGKILL')
process.exit(0)
