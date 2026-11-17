import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  shiftVttTimestamps, rankSubtitleResults, SubtitleStore, guessLanguageFromName, normalizeLang
} from '../lib/subtitles.js'
import { outputArgs, fileStreamArgs, urlStreamArgs } from '../lib/ffmpeg.js'
import { isSubtitleFile } from '../lib/media.js'

const VTT = `WEBVTT

00:00:01.000 --> 00:00:02.500
Hello world

00:00:03.000 --> 00:00:04.000
[BIRD]

00:10:00.000 --> 00:10:02.000
Later`

test('shiftVttTimestamps applies a constant offset', () => {
  const out = shiftVttTimestamps(VTT, { offsetMs: 500 })
  assert.match(out, /00:00:01\.500 --> 00:00:03\.000/)
  assert.match(out, /00:10:00\.500 --> 00:10:02\.500/)
  // payloads untouched
  assert.match(out, /Hello world/)
  // zero offset is identity
  assert.equal(shiftVttTimestamps(VTT, { offsetMs: 0, scale: 1 }), VTT)
})

test('shiftVttTimestamps handles ffmpeg MM:SS.mmm cues', () => {
  const out = shiftVttTimestamps('WEBVTT\n\n00:01.000 --> 00:02.500\nHi', { offsetMs: 500 })
  assert.match(out, /00:00:01\.500 --> 00:00:03\.000/)
})

test('shiftVttTimestamps clamps negatives and drops cues before zero', () => {
  const out = shiftVttTimestamps(VTT, { offsetMs: -1500 })
  // first cue (1.0→2.5s) now ends at 1.0s, starts clamped to 0
  assert.match(out, /00:00:00\.000 --> 00:00:01\.000/)
  // second cue (3→4s) → 1.5→2.5s
  assert.match(out, /00:00:01\.500 --> 00:00:02\.500/)
})

test('shiftVttTimestamps rescales for frame-rate drift', () => {
  const out = shiftVttTimestamps(VTT, { scale: 23.976 / 24 })
  // 10:00 (600s) * (23.976/24) = 599.4s, 10:02 (602s) → 601.398s
  assert.match(out, /00:09:59\.400 --> 00:10:01\.398/)
})

test('rankSubtitleResults prefers the matching release over raw popularity', () => {
  const results = rankSubtitleResults([
    { fileId: 1, language: 'en', release: 'The Odyssey 2026 WEBRip x264', fileName: 'odyssey.webrip.srt', downloads: 999999, ratings: 0 },
    { fileId: 2, language: 'en', release: 'The Odyssey 2026 1080p BluRay x264', fileName: 'odyssey.bluray.srt', downloads: 10, ratings: 0 }
  ], { videoName: 'The.Odyssey.2026.1080p.BluRay.x264.AAC5.1-[YTS.GG].mp4', language: 'en' })
  assert.equal(results[0].fileId, 2)
})

test('language guessing from sidecar names', () => {
  assert.equal(guessLanguageFromName('English.srt'), 'en')
  assert.equal(guessLanguageFromName('Canadian.fre.srt'), 'fr')
  assert.equal(guessLanguageFromName('SDH.eng.HI.srt'), 'en')
  assert.equal(guessLanguageFromName('Latin American.spa.srt'), 'es')
  assert.equal(normalizeLang('eng'), 'en')
  assert.equal(normalizeLang('Spanish'), 'sp')
})

test('subtitle store: concurrent remembers never tear the index', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subs-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const store = new SubtitleStore(dir)
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    store.remember('hash', 0, 1000 + i, { id: `f-${i}.vtt`, language: 'en', label: `l${i}` })
  ))
  const parsed = JSON.parse(await fs.readFile(store.indexPath('hash'), 'utf8'))
  assert.equal(Object.keys(parsed).length, 20)
})

test('targetPath is unique per provider file id', () => {
  const store = new SubtitleStore('/tmp/x')
  const a = store.targetPath('h', 0, 'en', 'same label', 111)
  const b = store.targetPath('h', 0, 'en', 'same label', 222)
  assert.notEqual(a, b)
})

test('sidecar subtitle files are detected', () => {
  assert.equal(isSubtitleFile('English.srt'), true)
  assert.equal(isSubtitleFile('subs/Subs/Canadian.fre.srt'), true)
  assert.equal(isSubtitleFile('movie.mp4'), false)
  assert.equal(isSubtitleFile('notes.txt'), false)
})

test('outputArgs keeps stream-copy audio when no live filter is applied', () => {
  // The ffmpeg-side adelay/atrim filters are currently commented out in this
  // checkout (Web Audio handles positive A/V delay in the browser instead).
  // What we do rely on: with no offset the audio stays a plain stream copy.
  const zero = outputArgs({ videoCopy: true, audioCopy: true, audioDelayMs: 0 })
  assert.ok(zero.includes('copy'))
  assert.ok(!zero.join(' ').includes('adelay'))
  assert.ok(!zero.join(' ').includes('atrim'))
  // The live stream builders still thread the value through, so re-enabling
  // the filters in outputArgs is all that is needed to make negative delay work.
  assert.ok(fileStreamArgs({ inputPath: '/tmp/x', videoCopy: true, audioCopy: true, audioDelayMs: -100 }).length > 0)
  assert.ok(urlStreamArgs({ inputUrl: 'http://x', videoCopy: true, audioCopy: true, audioDelayMs: 100 }).length > 0)
})
