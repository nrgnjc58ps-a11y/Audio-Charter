// Synthesizes a test "band" recording with a known tempo, chords and bar lines.
// Used by the engine tests and to make a sample file for browser tests.
'use strict';

const NOTE = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const QUAL = { '': [0, 4, 7], m: [0, 3, 7], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11] };

function parse(ch) {
  const m = /^([A-G][#b]?)(m7|maj7|m|7)?(?:\/([A-G][#b]?))?$/.exec(ch);
  if (!m) throw new Error('bad chord ' + ch);
  const root = NOTE[m[1]], q = m[2] || '';
  return { root, q, tones: QUAL[q].map(i => (root + i) % 12), bass: m[3] ? NOTE[m[3]] : root };
}
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

// Simple seeded RNG so tests are repeatable.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/**
 * opts: { sr, bpm, bpb, bars: ['E','','C#m',...] (empty = carry; 'A B' = two chords),
 *         leadIn (seconds of silence), pickupBeats, tuningCents, seed, swingDrift }
 */
function synth(opts) {
  const sr = opts.sr || 22050, bpm = opts.bpm, bpb = opts.bpb || 4;
  const beat = 60 / bpm, lead = opts.leadIn || 0.5, pickup = opts.pickupBeats || 0;
  const tune = Math.pow(2, (opts.tuningCents || 0) / 1200);
  const rand = rng(opts.seed || 1);
  // Expand bars into per-beat chord list.
  const beatsChords = [];
  let cur = null;
  for (const b of opts.bars) {
    const parts = b.trim() ? b.trim().split(/\s+/) : [];
    if (parts.length === 0) { for (let k = 0; k < bpb; k++) beatsChords.push(cur); }
    else if (parts.length === 1) { cur = parts[0]; for (let k = 0; k < bpb; k++) beatsChords.push(cur); }
    else { const h = bpb / 2; for (let k = 0; k < bpb; k++) beatsChords.push(parts[k < h ? 0 : 1]); cur = parts[1]; }
  }
  const totalBeats = pickup + beatsChords.length;
  const dur = lead + totalBeats * beat + 2;
  const n = Math.ceil(dur * sr);
  const y = new Float32Array(n);
  const beatTime = (i) => lead + i * beat; // i counts from start of pickup
  const barLines = [];
  for (let i = 0; i < opts.bars.length; i++) barLines.push(beatTime(pickup + i * bpb));

  const tone = (t0, len, f, amp, harmonics, decay) => {
    const a = Math.round(t0 * sr), b = Math.min(n, Math.round((t0 + len) * sr));
    const ph = rand() * 6.28;
    for (let i = a; i < b; i++) {
      const t = (i - a) / sr;
      const env = Math.min(1, t / 0.008) * Math.exp(-t * decay) * Math.min(1, (b - i) / (0.02 * sr));
      let s = 0;
      for (let h = 1; h <= harmonics; h++) s += Math.sin(2 * Math.PI * f * tune * h * t + ph * h) / Math.pow(h, 1.1);
      y[i] += amp * env * s;
    }
  };
  const noise = (t0, len, amp, decay, lp) => {
    const a = Math.round(t0 * sr), b = Math.min(n, Math.round((t0 + len) * sr));
    let z = 0;
    for (let i = a; i < b; i++) { const t = (i - a) / sr; const r = rand() * 2 - 1; z = lp * z + (1 - lp) * r; y[i] += amp * Math.exp(-t * decay) * z; }
  };
  const kick = (t0) => {
    const a = Math.round(t0 * sr), b = Math.min(n, a + Math.round(0.25 * sr));
    let ph = 0;
    for (let i = a; i < b; i++) { const t = (i - a) / sr; const f = 50 + 90 * Math.exp(-t * 30); ph += 2 * Math.PI * f / sr; y[i] += 0.8 * Math.exp(-t * 14) * Math.sin(ph); }
  };

  // Pickup: a single-note lead-in (no chord).
  for (let k = 0; k < pickup; k++) tone(beatTime(k), beat * 0.9, hz(64 + k), 0.12, 4, 3);

  for (let k = 0; k < beatsChords.length; k++) {
    const gi = pickup + k, t = beatTime(gi), pos = k % bpb;
    const ch = beatsChords[k]; if (!ch) continue;
    const p = parse(ch);
    const changed = k === 0 || beatsChords[k - 1] !== ch;
    // Drums: kick on 1 (and 3 in 4/4), snare on 2 and 4, hats on eighths.
    if (pos === 0 || (bpb === 4 && pos === 2)) kick(t);
    if (bpb === 4 ? (pos === 1 || pos === 3) : pos === 1 || pos === 2) noise(t, 0.2, 0.35, 18, 0.3);
    noise(t, 0.05, 0.08, 60, 0); noise(t + beat / 2, 0.05, 0.06, 60, 0);
    // Bass: root (or slash bass) on each beat, octave 2.
    const bm = 36 + ((p.bass - 0 + 12) % 12); // C2..B2
    tone(t, beat * 0.95, hz(bm < 40 ? bm + 12 : bm), 0.35, 5, 3);
    // Guitar-ish strum on every beat, accent on chord change.
    const voicing = [];
    for (const pc of p.tones) { let m = 52 + ((pc - 52 % 12 + 24) % 12); voicing.push(m); }
    voicing.push(voicing[0] + 12);
    voicing.forEach((m, j) => tone(t + j * 0.006, beat * 0.98, hz(m), changed ? 0.1 : 0.07, 8, 2.5));
    // Melody: chord tone on the beat, passing tone on the off-beat.
    const mel = 72 + p.tones[(k * 7) % p.tones.length] - 12 * (p.tones[(k * 7) % p.tones.length] > 7 ? 1 : 0);
    const vg = opts.vocal || 1;
    tone(t, beat * 0.5, hz(mel), 0.08 * vg, 3, opts.vocal ? 0.5 : 4);
    tone(t + beat / 2, beat * 0.45, hz(mel + (k % 3 === 0 ? 2 : 1)), 0.05 * vg, 3, opts.vocal ? 0.5 : 4);
  }
  // Light noise floor.
  for (let i = 0; i < n; i++) y[i] += (rand() * 2 - 1) * 0.003;
  let pk = 0; for (const v of y) pk = Math.max(pk, Math.abs(v));
  for (let i = 0; i < n; i++) y[i] = y[i] / pk * 0.9;
  return { y, sr, barLines, beat };
}

function wav(y, sr) {
  const buf = Buffer.alloc(44 + y.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + y.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(y.length * 2, 40);
  for (let i = 0; i < y.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(y[i] * 32767))), 44 + i * 2);
  return buf;
}

module.exports = { synth, wav, parse };

if (require.main === module) {
  const out = process.argv[2] || 'sample.wav';
  const s = synth({ bpm: 112, bars: ['E', '', 'C#m', '', 'A', '', 'B', '', 'E', '', 'C#m', '', 'A', 'B/A', 'E', ''] });
  require('fs').writeFileSync(out, wav(s.y, s.sr));
  console.log('wrote', out);
}
