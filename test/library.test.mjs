import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Library, parseFirstJsonDocument } from '../lib/library.js'

const HASH = 'b87a36d4b2341fd1a90da92754e456aadd092e6a'

async function tmpDir (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'library-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

function sampleMeta (overrides = {}) {
  return {
    infoHash: HASH,
    name: 'sample.mkv',
    length: 12345,
    files: [{ name: 'sample.mkv', path: 'sample.mkv', length: 12345 }],
    resume: { position: 42, duration: 600, fileIndex: 0 },
    ...overrides
  }
}

test('parseFirstJsonDocument recovers a document with trailing garbage', () => {
  const good = JSON.stringify(sampleMeta())
  const torn = `${good.slice(0, -1)}\n}"\n  }\n}` // complete doc + stray tail
  const { value, end } = parseFirstJsonDocument(torn)
  assert.equal(value.name, 'sample.mkv')
  assert.ok(torn.slice(end).trim().length > 0) // garbage left over
  assert.throws(() => parseFirstJsonDocument('{"a":'), /incomplete/)
  assert.throws(() => JSON.parse(torn), SyntaxError)
})

test('read repairs a torn sidecar instead of returning null', async t => {
  const dir = await tmpDir(t)
  const lib = new Library(dir, { log: () => {} })
  const meta = sampleMeta()
  const good = JSON.stringify(meta, null, 2)
  await fs.writeFile(lib.metaPath(HASH), `${good.slice(0, -1)}\n}"\n  }\n}`)
  await fs.writeFile(lib.torrentPath(HASH), Buffer.from('fake-torrent'))

  const items = await lib.list()
  assert.equal(items.length, 1)
  assert.equal(items[0].infoHash, HASH)
  assert.equal(items[0].name, 'sample.mkv')
  assert.equal(items[0].hasTorrentFile, true)
  // resume survives the repair
  assert.equal(items[0].resume.position, 42)
  // file on disk is valid JSON afterwards
  assert.equal(JSON.parse(await fs.readFile(lib.metaPath(HASH), 'utf8')).name, 'sample.mkv')
})

test('list still shows an item whose sidecar is missing entirely', async t => {
  const dir = await tmpDir(t)
  const lib = new Library(dir, { log: () => {} })
  await fs.writeFile(lib.torrentPath(HASH), Buffer.from('fake-torrent'))
  // no .json at all: the .torrent alone is enough to list + restore
  const items = await lib.list()
  assert.equal(items.length, 1)
  assert.equal(items[0].infoHash, HASH)
  assert.equal(items[0].hasTorrentFile, true)
  assert.equal(items[0].recovered, true)
})

test('concurrent patches serialize and never tear the sidecar', async t => {
  const dir = await tmpDir(t)
  const lib = new Library(dir, { log: () => {} })
  await fs.writeFile(lib.metaPath(HASH), JSON.stringify(sampleMeta()))

  await Promise.all(Array.from({ length: 25 }, (_, i) =>
    lib.patch(HASH, { resume: { position: i, duration: 600, fileIndex: 0 } })
  ))

  const raw = await fs.readFile(lib.metaPath(HASH), 'utf8')
  const meta = JSON.parse(raw) // must not throw
  assert.equal(meta.infoHash, HASH)
  assert.equal(typeof meta.resume.position, 'number')
  // no temp files left behind
  const names = await fs.readdir(dir)
  assert.deepEqual(names.filter(n => n.endsWith('.tmp')), [])
})
