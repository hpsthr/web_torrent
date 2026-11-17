/**
 * Drives the real UI over Chrome DevTools Protocol and checks playback.
 *
 *   npm run ui-test                       # tests the first item in your library
 *   node test/ui-seek.mjs <infoHash> [name-substring]
 *
 * Launches headless Chrome with remote debugging, clicks the library Play button
 * (so the app's own state machine runs), then exercises pause/resume and the
 * -10 / +10 buttons, reporting the on-screen clock.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333
const APP = process.env.APP_URL || 'http://127.0.0.1:5173'
const profile = '/tmp/webtorent-cdp-profile'

if (!fs.existsSync(CHROME)) {
  console.error(`Chrome not found at:\n  ${CHROME}\nSet CHROME_PATH or run the app in a browser by hand.`)
  process.exit(1)
}

/** With no argument, test whatever is in the library - no setup file required. */
async function resolveTarget () {
  if (process.argv[2]) return { infoHash: process.argv[2], name: process.argv[3] || '' }
  let items
  try {
    const res = await fetch(`${APP}/api/library`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    items = (await res.json()).items
  } catch (err) {
    console.error(`Could not reach the app at ${APP} (${err.message}).\nIs it running?  npm start`)
    process.exit(1)
  }
  if (!items.length) {
    console.error('The library is empty. Open a magnet in the app first, or pass an infoHash:\n  node test/ui-seek.mjs <infoHash>')
    process.exit(1)
  }
  const item = items[0]
  console.log(`Testing library item: ${item.name}`)
  return { infoHash: item.infoHash, name: item.name }
}

const { infoHash, name: NAME } = await resolveTarget()

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  'about:blank'
], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function targets () {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find(t => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch { /* not up yet */ }
    await sleep(250)
  }
  throw new Error('Chrome devtools never came up')
}

class Cdp {
  constructor (ws) { this.ws = ws; this.id = 0; this.pending = new Map() }
  static async connect (url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    const cdp = new Cdp(ws)
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data)
      const p = cdp.pending.get(msg.id)
      if (p) { cdp.pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result) }
    }
    return cdp
  }
  send (method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => this.pending.set(id, { res, rej }))
  }
  async eval (expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
    return r.result.value
  }
}

try {
  const page = await targets()
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  await cdp.send('Page.navigate', { url: APP })
  await sleep(2500)

  const report = await cdp.eval(`(async () => {
    const lines = []
    const say = m => lines.push(m)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const IH = ${JSON.stringify(infoHash)}
    const NAME = ${JSON.stringify(NAME)}

    // Wait for the library to render, then click the real Play button for this
    // item - that runs the app's own openFromLibrary -> startPlayback flow.
    let playBtn = null
    for (let i = 0; i < 40 && !playBtn; i++) {
      const rows = [...document.querySelectorAll('#library-list li')]
      const row = rows.find(li => li.textContent.includes(NAME)) || rows[0]
      if (row) playBtn = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === 'Play')
      if (!playBtn) await wait(250)
    }
    if (!playBtn) { say('could not find a Play button in the library'); return lines.join('\\n') }
    playBtn.click()
    await wait(7000)

    const v = document.getElementById('video')
    say('after Play: currentTime=' + v.currentTime.toFixed(2) + ' readyState=' + v.readyState
        + ' paused=' + v.paused + ' duration=' + (isFinite(v.duration) ? v.duration.toFixed(1) : 'n/a')
        + ' src=' + (v.currentSrc || '').replace(/^.*\\//, ''))
    say('chips: ' + document.getElementById('chip-mode').textContent)

    if (!(v.currentTime > 0)) {
      try { v.currentTime = 40; await wait(1500) } catch (e) { say('set currentTime failed: ' + e.message) }
      say('forced currentTime to ' + v.currentTime.toFixed(2) + ' (headless playback may not advance)')
    }

    const shown = () => document.getElementById('time-now').textContent
    const chip = () => document.getElementById('chip-mode').textContent
    say('chip while playing : ' + chip())
    say('displayed before    : ' + shown())

    // --- the pause / resume cycle that used to kill the stream ---
    v.pause()
    say('paused')
    await wait(8000)               // longer than the 6s stop-download delay
    say('after 8s paused  chip: ' + chip())
    await v.play().catch(e => say('resume blocked: ' + e.message))
    await wait(3000)
    say('after resume      : ' + shown() + '  readyState=' + v.readyState + '  chip=' + chip())
    say('video.error after resume: ' + (v.error ? v.error.code + ' ' + v.error.message : 'none'))

    // --- arrow keys ---
    document.getElementById('file-select').focus()
    say('focus is on      : ' + document.activeElement.tagName)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await wait(3000)
    say('AFTER ArrowRight : ' + shown() + '  (focus now ' + document.activeElement.tagName + ')')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await wait(3000)
    say('AFTER ArrowLeft  : ' + shown())

    return lines.join('\\n')
  })()`)

  console.log(report)
} catch (err) {
  console.error('test failed:', err.message)
} finally {
  chrome.kill('SIGKILL')
}
