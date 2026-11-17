// Makes a clean synthetic mix sound like a phone recording of a speaker in a room:
// thin bass, muffled top, room echo, background noise.
'use strict';
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function onePoleHP(x, sr, fc) {
  const a = Math.exp(-2 * Math.PI * fc / sr), y = new Float32Array(x.length);
  let px = 0, py = 0;
  for (let i = 0; i < x.length; i++) { py = a * (py + x[i] - px); px = x[i]; y[i] = py; }
  return y;
}
function onePoleLP(x, sr, fc) {
  const a = Math.exp(-2 * Math.PI * fc / sr), y = new Float32Array(x.length);
  let p = 0;
  for (let i = 0; i < x.length; i++) { p = (1 - a) * x[i] + a * p; y[i] = p; }
  return y;
}
function reverb(x, sr, mix) {
  const combs = [0.0297, 0.0371, 0.0411, 0.0437].map(d => Math.round(d * sr));
  const out = new Float32Array(x.length);
  for (const d of combs) {
    const buf = new Float32Array(d); let k = 0;
    for (let i = 0; i < x.length; i++) { const y = buf[k]; buf[k] = x[i] + 0.8 * y; out[i] += y / combs.length; k = (k + 1) % d; }
  }
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = (1 - mix) * x[i] + mix * out[i];
  return y;
}
function degrade(x, sr, opts = {}) {
  const rand = rng(opts.seed || 3);
  let y = onePoleHP(onePoleHP(x, sr, opts.lowCut || 220), sr, opts.lowCut || 220);
  y = onePoleLP(y, sr, opts.highCut || 5000);
  y = reverb(y, sr, opts.reverb ?? 0.45);
  let pk = 0; for (const v of y) pk = Math.max(pk, Math.abs(v));
  let rms = 0; for (const v of y) rms += v * v; rms = Math.sqrt(rms / y.length);
  const nAmp = rms * Math.pow(10, -(opts.snr ?? 12) / 20) * Math.sqrt(3);
  let b = 0;
  for (let i = 0; i < y.length; i++) { b = 0.97 * b + 0.03 * (rand() * 2 - 1); y[i] += nAmp * (rand() * 2 - 1) * 0.5 + nAmp * b * 6; }
  pk = 0; for (const v of y) pk = Math.max(pk, Math.abs(v));
  for (let i = 0; i < y.length; i++) y[i] = y[i] / pk * 0.5;
  return y;
}
module.exports = { degrade };
