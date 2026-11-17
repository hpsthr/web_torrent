/**
 * Progressive-MP4 repair.
 *
 * A WEB-DL style MP4 usually stores its index (`moov`) at the *end* of the file,
 * after the bulk data (`mdat`). That layout is fatal for streaming: the browser
 * cannot learn the duration, cannot seek, and will not start playing until it has
 * the whole file.
 *
 * The index itself is small, and the only thing tying it to the old position is
 * the chunk-offset tables (`stco`/`co64`) inside it, which hold absolute file
 * offsets. So we can fetch just the index, shift those offsets to account for the
 * index moving to the front, and then serve a *virtual* file laid out as
 *
 *     [ftyp][moov][mdat]
 *
 * where the mdat bytes are streamed from the torrent on demand. The browser sees
 * an ordinary faststart MP4: it starts immediately and seeks natively, with no
 * ffmpeg and no waiting for the full download.
 */

const CONTAINER_BOXES = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'mvex', 'moof', 'traf', 'mfra'
])

/** Read a box header at `offset`. Returns null if it does not fit. */
export function readBoxHeader (buf, offset) {
  if (offset + 8 > buf.length) return null
  let size = buf.readUInt32BE(offset)
  const type = buf.toString('latin1', offset + 4, offset + 8)
  let headerSize = 8
  if (size === 1) {
    if (offset + 16 > buf.length) return null
    size = Number(buf.readBigUInt64BE(offset + 8))
    headerSize = 16
  } else if (size === 0) {
    size = buf.length - offset // extends to end of file
  }
  if (size < headerSize) return null
  return { offset, size, type, headerSize }
}

/** Walk the top-level boxes present in a buffer. */
export function topLevelBoxes (buf) {
  const boxes = []
  let offset = 0
  while (offset + 8 <= buf.length) {
    const box = readBoxHeader(buf, offset)
    if (!box) break
    boxes.push(box)
    offset += box.size
  }
  return boxes
}

/**
 * Shift every chunk offset inside a `moov` by `delta`.
 *
 * Only `stco` (32-bit) and `co64` (64-bit) carry absolute file offsets; all the
 * other tables are counts, durations and indices that do not move.
 */
export function shiftChunkOffsets (moov, delta) {
  let patched = 0
  walk(moov, 0, moov.length)
  return patched

  function walk (buf, start, end) {
    let offset = start
    while (offset + 8 <= end) {
      const box = readBoxHeader(buf, offset)
      if (!box || offset + box.size > end) break

      if (box.type === 'stco' || box.type === 'co64') {
        const entrySize = box.type === 'stco' ? 4 : 8
        const count = buf.readUInt32BE(offset + box.headerSize + 4)
        let p = offset + box.headerSize + 8
        for (let i = 0; i < count; i++) {
          if (p + entrySize > offset + box.size) break
          if (entrySize === 4) {
            const value = buf.readUInt32BE(p)
            buf.writeUInt32BE(Math.max(0, value + delta) >>> 0, p)
          } else {
            const value = Number(buf.readBigUInt64BE(p))
            buf.writeBigUInt64BE(BigInt(Math.max(0, value + delta)), p)
          }
          p += entrySize
          patched++
        }
      } else if (CONTAINER_BOXES.has(box.type)) {
        walk(buf, offset + box.headerSize, offset + box.size)
      }

      offset += box.size
    }
  }
}

/**
 * Given the head of the file and its `moov`, work out the layout.
 *
 * @returns {null | { header: Buffer, mdatOffset: number, mdatLength: number, shifted: number, totalLength: number }}
 */
export function buildFaststartLayout ({ head, moov, fileLength }) {
  const boxes = topLevelBoxes(head)
  const ftyp = boxes.find(b => b.type === 'ftyp')
  const mdat = boxes.find(b => b.type === 'mdat')
  if (!ftyp || !mdat || !moov) return null

  const ftypBuf = Buffer.from(head.subarray(ftyp.offset, ftyp.offset + ftyp.size))
  const moovBuf = Buffer.from(moov)

  const newMdatOffset = ftypBuf.length + moovBuf.length
  const delta = newMdatOffset - mdat.offset
  const shifted = shiftChunkOffsets(moovBuf, delta)

  // The mdat header itself is preserved, so the virtual mdat is byte-identical.
  const mdatHeaderLength = mdat.headerSize
  const mdatLength = mdat.size
  if (mdatLength <= 0) return null

  return {
    header: Buffer.concat([ftypBuf, moovBuf]),
    mdatOffset: mdat.offset,
    mdatHeaderLength,
    mdatLength,
    shifted,
    delta,
    totalLength: newMdatOffset + mdatLength,
    originalLength: fileLength
  }
}
