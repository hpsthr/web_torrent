/**
 * Deterministic end-to-end test seeder.
 *
 * Starts a local BitTorrent tracker, seeds the fixtures from ./fixtures and
 * writes the resulting magnet to test/torrent.json. Using a local tracker means
 * the test does not depend on the public swarm, DHT or local peer discovery.
 */
import WebTorrent from 'webtorrent'
import { Server } from 'bittorrent-tracker'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')
const PORT = Number(process.env.TEST_TRACKER_PORT || 8123)
const NAME = process.env.TEST_NAME || 'webtorent-fixtures'
const OUT = process.env.TEST_OUT || 'torrent.json'
const ANNOUNCE = `http://127.0.0.1:${PORT}/announce`

const files = fs.readdirSync(fixtures)
  .filter(name => !name.startsWith('.'))
  .map(name => path.join(fixtures, name))

if (files.length === 0) {
  console.error('no fixtures found - run test/make-fixtures.sh first')
  process.exit(1)
}

const tracker = new Server({ udp: false, ws: true, http: true, stats: false })
await new Promise(resolve => tracker.listen(PORT, '127.0.0.1', resolve))
console.log(`local tracker listening on ${ANNOUNCE}`)

const client = new WebTorrent({ dht: false, lsd: false, utP: false, maxConns: 50 })
client.on('error', err => console.error('[seeder]', err.message))

client.seed(files, { announce: [ANNOUNCE], name: NAME }, torrent => {
  const payload = {
    magnet: torrent.magnetURI,
    infoHash: torrent.infoHash,
    announce: ANNOUNCE,
    files: torrent.files.map(file => ({ name: file.name, length: file.length }))
  }
  fs.writeFileSync(path.join(here, OUT), JSON.stringify(payload, null, 2))
  console.log(JSON.stringify(payload, null, 2))
  console.log('\nseeding - press Ctrl+C to stop')
})

setInterval(() => {
  const torrent = client.torrents[0]
  if (!torrent) return
  console.log(`[seeder] peers=${torrent.numPeers} uploaded=${(torrent.uploaded / 1e6).toFixed(1)}MB`)
}, 5000).unref?.()
