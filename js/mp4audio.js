// Pulls the AAC soundtrack out of an MP4 / MOV video (e.g. an iPhone screen
// recording) without loading the whole video into memory: only the file's index
// (moov) and the audio frames are read from the Blob. The frames are copied as
// they are (no re-encoding) into a small audio-only .m4a, or an ADTS .aac stream,
// which browsers decode even when they won't decode sound from a video file.

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
    out.push({ type, at: o, start: o + header, end: o + size });
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

// ---------------------------------------------------------------- reading from a Blob

const read = async (blob, a, b) => new Uint8Array(await blob.slice(a, b).arrayBuffer());

/** True if the Blob starts like an MP4 / MOV / M4A file. */
export async function looksLikeMp4(blob) {
  if (blob.size < 12) return false;
  const h = await read(blob, 0, 12);
  const t = String.fromCharCode(h[4], h[5], h[6], h[7]);
  return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(t);
}

/** Reads just the top-level 'moov' box (the file's index). */
async function readMoov(blob) {
  let o = 0;
  for (let n = 0; o + 8 <= blob.size && n < 64; n++) {
    const h = await read(blob, o, Math.min(blob.size, o + 16));
    const dv = new DataView(h.buffer);
    let size = dv.getUint32(0);
    const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
    if (size === 1) size = Number(dv.getBigUint64(8));
    else if (size === 0) size = blob.size - o;
    if (size < 8) return null;
    if (type === 'moov') {
      if (size > 64 * 1024 * 1024) return null;
      return read(blob, o, o + size);
    }
    o += size;
  }
  return null;
}

// ---------------------------------------------------------------- writing

function u32b(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function box(type, ...parts) {
  const len = 8 + parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  out.set(u32b(len), 0);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const bytes = (...arr) => Uint8Array.from(arr.flat());
const raw = (u8, b) => u8.subarray(b.at, b.end);

/** Audio-only .m4a holding the same AAC frames (Safari's own format for AAC). */
function buildM4a(m, v, track, frames, total) {
  const { trak } = track;
  const mvhd = child(v, track.moov, 'mvhd');
  const tkhd = child(v, trak, 'tkhd');
  const mdia = child(v, trak, 'mdia');
  const mdhd = child(v, mdia, 'mdhd'), hdlr = child(v, mdia, 'hdlr');
  const minf = child(v, mdia, 'minf');
  const stbl = child(v, minf, 'stbl');
  const stsd = child(v, stbl, 'stsd'), stts = child(v, stbl, 'stts'), stsz = child(v, stbl, 'stsz');
  if (!mvhd || !tkhd || !mdhd || !hdlr || !stsd || !stts || !stsz) return null;
  const ftyp = box('ftyp', bytes([...'M4A '].map(c => c.charCodeAt(0)), [0, 0, 0, 0], [...'M4A mp42isom'].map(c => c.charCodeAt(0))));
  const make = (dataOffset) => {
    const stsc = box('stsc', bytes([0, 0, 0, 0], u32b(1), u32b(1), u32b(track.count), u32b(1)));
    const stco = box('stco', bytes([0, 0, 0, 0], u32b(1), u32b(dataOffset)));
    const newStbl = box('stbl', raw(m, stsd), raw(m, stts), stsc, raw(m, stsz), stco);
    const smhd = box('smhd', bytes([0, 0, 0, 0, 0, 0, 0, 0]));
    const dinf = box('dinf', box('dref', bytes([0, 0, 0, 0], u32b(1)), box('url ', bytes([0, 0, 0, 1]))));
    const newMinf = box('minf', smhd, dinf, newStbl);
    const newTrak = box('trak', raw(m, tkhd), box('mdia', raw(m, mdhd), raw(m, hdlr), newMinf));
    return box('moov', raw(m, mvhd), newTrak);
  };
  const moovLen = make(0).length;
  const moov = make(ftyp.length + moovLen + 8);
  const out = new Uint8Array(ftyp.length + moov.length + 8 + total);
  out.set(ftyp, 0); out.set(moov, ftyp.length);
  let o = ftyp.length + moov.length;
  out.set(u32b(8 + total), o); out.set([0x6d, 0x64, 0x61, 0x74], o + 4); o += 8;
  for (const f of frames) { out.set(f, o); o += f.length; }
  return out;
}

/** ADTS .aac stream: each frame gets a 7-byte header. */
function buildAdts(cfg, frames) {
  const profile = (cfg.aot >= 1 && cfg.aot <= 4 ? cfg.aot : 2) - 1; // HE-AAC is signalled implicitly as LC
  const out = new Uint8Array(frames.reduce((a, f) => a + f.length + 7, 0));
  let o = 0;
  for (const f of frames) {
    const len = f.length + 7;
    out[o] = 0xff; out[o + 1] = 0xf1;
    out[o + 2] = (profile << 6) | (cfg.sfIndex << 2) | (cfg.channels >> 2);
    out[o + 3] = ((cfg.channels & 3) << 6) | (len >> 11);
    out[o + 4] = (len >> 3) & 0xff;
    out[o + 5] = ((len & 7) << 5) | 0x1f;
    out[o + 6] = 0xfc;
    out.set(f, o + 7);
    o += len;
  }
  return out;
}

/**
 * Finds the AAC soundtrack in an MP4/MOV Blob and returns
 * { m4a: Uint8Array|null, adts: Uint8Array|null, skipSeconds } or null.
 * skipSeconds is the encoder priming at the start that video players hide.
 */
export async function extractAudio(blob) {
  const m = await readMoov(blob);
  if (!m) return null;
  const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
  const moov = boxes(v, 0, m.length).find(b => b.type === 'moov');
  if (!moov) return null;
  let track = null;
  for (const trak of boxes(v, moov.start, moov.end).filter(b => b.type === 'trak')) {
    try { track = audioTrack(v, trak); } catch { track = null; }
    if (track && track.count) { track.trak = trak; track.moov = moov; break; }
  }
  if (!track || !track.count || !track.cfg.channels || track.cfg.channels > 7) return null;
  // Read the audio frames. Frames close together (small gaps of video between
  // them) share one read; frames are copied out so the reads can be freed.
  const { sizes, offsets, count } = track;
  const spans = [];
  for (let i = 0; i < count;) {
    let j = i + 1, end = offsets[i] + sizes[i];
    while (j < count && offsets[j] >= end && offsets[j] - end <= 64 * 1024 && offsets[j] + sizes[j] - offsets[i] <= 2 * 1024 * 1024) { end = offsets[j] + sizes[j]; j++; }
    spans.push({ i, j, start: offsets[i], end });
    i = j;
  }
  const frames = new Array(count);
  let total = 0, okUntil = count;
  for (let b = 0; b < spans.length; b += 4) {
    await Promise.all(spans.slice(b, b + 4).map(async (sp) => {
      if (sp.end > blob.size) { okUntil = Math.min(okUntil, sp.i); return; }
      const chunk = await read(blob, sp.start, sp.end);
      for (let k = sp.i; k < sp.j; k++) {
        const p = offsets[k] - sp.start;
        frames[k] = chunk.slice(p, p + sizes[k]);
      }
    }));
  }
  let i = 0;
  while (i < okUntil && frames[i]) { total += frames[i].length; i++; }
  const got = frames.slice(0, i);
  if (!got.length) return null;
  track.count = got.length;
  let m4a = null;
  try { m4a = buildM4a(m, v, track, got, total); } catch { m4a = null; }
  return { m4a, adts: buildAdts(track.cfg, got), skipSeconds: Math.max(0, Math.min(1, track.skipSeconds)) };
}
