// Runs the analysis engine on synthetic songs with known answers.
// Usage: node tests/dsp.test.js
'use strict';
const DSP = require('../js/dsp.js');
const { synth, parse } = require('./synth.js');
const { degrade } = require('./degrade.js');
const PHONE = process.argv.includes('--phone');
const HARSH = process.argv.includes('--harsh');

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const itemName = (it) => it.nc ? 'N.C.' : NAMES[it.root] + it.quality + (it.bass >= 0 ? '/' + NAMES[it.bass] : '');
const expName = (c) => { const p = parse(c); return NAMES[p.root] + p.q + (p.bass !== p.root ? '/' + NAMES[p.bass] : ''); };

const cases = [
  { name: 'Pop in E, 112 BPM', bpm: 112, key: 'E', bars: ['E', '', 'C#m', '', 'A', '', 'B', '', 'E', '', 'C#m', '', 'A', 'B/A', 'E', '', 'A', '', 'E', '', 'A', '', 'B', ''] },
  { name: 'Flat key Bb, 92 BPM, half-bar changes', bpm: 92, key: 'Bb', bars: ['Bb', 'Gm', 'Eb F', 'Bb', 'Bb', 'Gm', 'Eb F', 'Bb', 'Eb', '', 'Bb', '', 'Cm', 'F', 'Bb', ''] },
  { name: 'Minor key Am, 128 BPM, pickup + 30 cents sharp', bpm: 128, key: 'Am', pickupBeats: 1, tuningCents: 30, bars: ['Am', '', 'F', '', 'C', '', 'G', '', 'Am', '', 'F', '', 'C', 'G', 'Am', '', 'Dm', '', 'Am', '', 'E', '', 'Am', ''] },
  { name: '3/4 waltz in G, 96 BPM', bpm: 96, bpb: 3, key: 'G', bars: ['G', '', 'C', '', 'D', '', 'G', '', 'Em', '', 'C', '', 'D', '', 'G', ''] },
  { name: 'Slow ballad in D, 72 BPM', bpm: 72, key: 'D', bars: ['D', '', 'Bm', '', 'G', '', 'A', '', 'D', 'A/C#', 'Bm', '', 'G', 'A', 'D', ''] },
];

const KEYN = (k) => NAMES[k.tonic] + (k.minor ? 'm' : '');
let fails = 0;
for (const c of cases) {
  const s = synth({ ...c, seed: 7, vocal: HARSH ? 6 : PHONE ? 3 : 0 });
  if (PHONE || HARSH) s.y = degrade(s.y, s.sr, HARSH ? { seed: 5, snr: 4, reverb: 0.65, lowCut: 300, highCut: 3500 } : { seed: 5 });
  const t0 = Date.now();
  const r = DSP.analyze(s.y, { beatsPerBar: c.bpb || 4, sections: true });
  const ms = Date.now() - t0;
  // Expected effective chord for each bar.
  const exp = []; let cur = null;
  for (const b of c.bars) { if (b.trim()) cur = b.trim().split(/\s+/).map(expName).join(' '); exp.push(cur); }
  // Align: for each expected bar line find detected bar starting within 15% of a bar.
  const barDur = s.beat * (c.bpb || 4);
  let aligned = 0, chordOk = 0, offs = [];
  const rows = [];
  s.barLines.forEach((t, i) => {
    const d = r.bars.find(b => Math.abs(b.start - t) < 0.15 * barDur);
    if (!d) { rows.push(`  bar ${i + 1}: expected ${exp[i]} — no bar line found`); return; }
    aligned++; offs.push(d.start - t);
    const got = d.items.map(itemName).join(' ');
    if (got === exp[i]) chordOk++; else rows.push(`  bar ${i + 1}: expected ${exp[i]}, got ${got}`);
  });
  const keyOk = KEYN(r.key) === (c.key === 'Bb' ? 'Bb' : c.key);
  const bpmOk = Math.abs(r.bpm - c.bpm) < 1;
  const meterOk = r.beatsPerBar === (c.bpb || 4);
  const ok = keyOk && bpmOk && aligned === s.barLines.length && chordOk >= s.barLines.length - 1;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  (${ms} ms)`);
  console.log(`  bpm ${r.bpm.toFixed(2)} (want ${c.bpm})  key ${KEYN(r.key)} (want ${c.key})  meter ${r.beatsPerBar}${meterOk ? '' : ' WRONG'}  tuning ${r.tuningCents}c`);
  console.log(`  bar lines found ${aligned}/${s.barLines.length}, mean offset ${(offs.reduce((a, v) => a + v, 0) / Math.max(1, offs.length) * 1000).toFixed(0)} ms; chords right ${chordOk}/${s.barLines.length}; sections at bars ${r.sections.map(x => x.bar + 1).join(',')}`);
  rows.forEach(l => console.log(l));
}
console.log(fails ? `${fails} case(s) failed` : 'All cases passed');
process.exit(fails ? 1 : 0);
