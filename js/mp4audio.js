// Pulls the AAC soundtrack out of an MP4 / MOV video (e.g. an iPhone screen
// recording) and returns it as a plain ADTS .aac stream, which browsers can
// decode even when they won't decode audio from a video file directly.
// No re-encoding: the audio frames are copied as they are.

function u32(v, o) { return v.getUint32(o); }
function type4(v, o) { return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3)); }

/** Lists the boxes between start and end: [{type, start (of content), end}] */
function boxes(v, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32(v, o);
    const type = type4(v, o + 4);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) break;
      size = Number(v.getBigUint64(o + 8)); header = 16;
    } else if (size === 0) size = end - o;
    if (size < header || o + size > end) break;
    out.push({ type, start: o + header, end: o + size });
    o += size;
  }
  return out;
}
const child = (v, box, type) => box && boxes(v, box.start, box.end).find(b => b.type === type);
const path = (v, box, ...types) => types.reduce((b, t) => child(v, b, t), box);

/** Depth-first search for a box type anywhere inside [start, end). */
function find(v, start, end, type, depth = 0) {
  if (depth > 6) return null;
  for (const b of boxes(v, start, end)) {
    if (b.type === type) return b;
    if (b.end - b.start >= 8) { const r = find(v, b.start, b.end, type, depth + 1); if (r) return r; }
  }
  return null;
}

function readDescLen(v, o) {
  let len = 0, i = 0, b;
  do { b = v.getUint8(o + i); len = (len << 7) | (b & 0x7f); i++; } while ((b & 0x80) && i < 4);
  return { len, bytes: i };
}

/** AudioSpecificConfig from an esds box: { aot, sfIndex, channels } */
function parseEsds(v, esds) {
  let o = esds.start + 4; // version + flags
  const end = esds.end;
  while (o < end) {
    const tag = v.getUint8(o);
    const { len, bytes } = readDescLen(v, o + 1);
    const body = o + 1 + bytes;
    if (tag === 0x03) { // ES_Descriptor
      let p = body + 2; const flags = v.getUint8(p); p++;
      if (flags & 0x80) p += 2;
      if (flags & 0x40) p += 1 + v.getUint8(p);
      if (flags & 0x20) p += 2;
      o = p; continue;
    }
    if (tag === 0x04) { o = body + 13; continue; } // DecoderConfigDescriptor header
    if (tag === 0x05) { // DecoderSpecificInfo = AudioSpecificConfig
      const b0 = v.getUint8(body), b1 = v.getUint8(body + 1);
      let aot = b0 >> 3, sfIndex = ((b0 & 7) << 1) | (b1 >> 7), channels = (b1 >> 3) & 0xf;
      if (sfIndex === 15) return null; // explicit frequency: rare, not supported in ADTS
      return { aot, sfIndex, channels };
    }
    o = body + len;
  }
  return null;
}

function audioTrack(v, trak) {
  const hdlr = path(v, trak, 'mdia', 'hdlr');
  if (!hdlr || type4(v, hdlr.start + 8) !== 'soun') return null;
  const stbl = path(v, trak, 'mdia', 'minf', 'stbl');
  const stsd = child(v, stbl, 'stsd');
  if (!stsd) return null;
  const entry = boxes(v, stsd.start + 8, stsd.end)[0];
  if (!entry || entry.type !== 'mp4a') return null;
  // Sound sample description: 28 bytes, plus 16 (QuickTime version 1) or 36 (version 2).
  const ver = v.getUint16(entry.start + 8);
  const skip = 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
  const esds = find(v, entry.start + skip, entry.end, 'esds');
  const cfg = esds && parseEsds(v, esds);
  if (!cfg) return null;
  // Sample sizes.
  const stsz = child(v, stbl, 'stsz');
  const fixed = u32(v, stsz.start + 4), count = u32(v, stsz.start + 8);
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || u32(v, stsz.start + 12 + 4 * i);
  // Chunk offsets.
  const stco = child(v, stbl, 'stco'), co64 = child(v, stbl, 'co64');
  const chunks = [];
  if (stco) { const n = u32(v, stco.start + 4); for (let i = 0; i < n; i++) chunks.push(u32(v, stco.start + 8 + 4 * i)); }
  else if (co64) { const n = u32(v, co64.start + 4); for (let i = 0; i < n; i++) chunks.push(Number(v.getBigUint64(co64.start + 8 + 8 * i))); }
  // Samples per chunk.
  const stsc = child(v, stbl, 'stsc');
  const runs = [];
  const nr = u32(v, stsc.start + 4);
  for (let i = 0; i < nr; i++) runs.push({ first: u32(v, stsc.start + 8 + 12 * i), per: u32(v, stsc.start + 12 + 12 * i) });
  const offsets = new Float64Array(count);
  let s = 0;
  for (let c = 0; c < chunks.length && s < count; c++) {
    let per = 0;
    for (const r of runs) if (r.first <= c + 1) per = r.per;
    let off = chunks[c];
    for (let k = 0; k < per && s < count; k++) { offsets[s] = off; off += sizes[s]; s++; }
  }
  // Encoder priming to skip: the edit list's media start, in the track's timescale.
  let skipSeconds = 0;
  try {
    const mdhd = path(v, trak, 'mdia', 'mdhd');
    const scale = v.getUint8(mdhd.start) === 1 ? u32(v, mdhd.start + 20) : u32(v, mdhd.start + 12);
    const elst = path(v, trak, 'edts', 'elst');
    if (elst && scale) {
      const ver = v.getUint8(elst.start), n = u32(v, elst.start + 4);
      for (let i = 0, o = elst.start + 8; i < n; i++) {
        const mt = ver === 1 ? Number(v.getBigInt64(o + 8)) : v.getInt32(o + 4);
        o += ver === 1 ? 20 : 12;
        if (mt >= 0) { skipSeconds = mt / scale; break; }
      }
    }
  } catch { skipSeconds = 0; }
  return { cfg, sizes, offsets, count: s, skipSeconds };
}

/**
 * Returns { data: Uint8Array (ADTS AAC stream), skipSeconds } or null if no AAC track is found.
 * skipSeconds is the encoder priming at the start that the video player hides.
 */
export function extractAac(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  const top = boxes(v, 0, v.byteLength);
  const moov = top.find(b => b.type === 'moov');
  if (!moov) return null;
  let track = null;
  for (const trak of boxes(v, moov.start, moov.end).filter(b => b.type === 'trak')) {
    try { track = audioTrack(v, trak); } catch { track = null; }
    if (track && track.count) break;
  }
  if (!track || !track.count) return null;
  const { cfg, sizes, offsets, count, skipSeconds } = track;
  if (!cfg.channels || cfg.channels > 7) return null;
  // ADTS profile: AAC Main/LC/SSR/LTP map directly; HE-AAC (SBR/PS) is signalled implicitly as LC.
  const profile = (cfg.aot >= 1 && cfg.aot <= 4 ? cfg.aot : 2) - 1;
  let total = 0;
  for (let i = 0; i < count; i++) if (offsets[i] + sizes[i] <= v.byteLength) total += sizes[i] + 7;
  const out = new Uint8Array(total);
  const src = new Uint8Array(arrayBuffer);
  let o = 0;
  for (let i = 0; i < count; i++) {
    const size = sizes[i], at = offsets[i];
    if (at + size > v.byteLength) continue;
    const len = size + 7;
    out[o] = 0xff;
    out[o + 1] = 0xf1;
    out[o + 2] = (profile << 6) | (cfg.sfIndex << 2) | (cfg.channels >> 2);
    out[o + 3] = ((cfg.channels & 3) << 6) | (len >> 11);
    out[o + 4] = (len >> 3) & 0xff;
    out[o + 5] = ((len & 7) << 5) | 0x1f;
    out[o + 6] = 0xfc;
    out.set(src.subarray(at, at + size), o + 7);
    o += len;
  }
  return { data: out, skipSeconds: Math.max(0, Math.min(1, skipSeconds)) };
}
