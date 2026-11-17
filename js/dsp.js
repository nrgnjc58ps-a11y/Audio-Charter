/*
 * Audio Charter — analysis engine (tempo, beats, downbeats, key, chords).
 *
 * Plain script with no dependencies. Loaded by the analysis Web Worker via
 * importScripts(), and by Node for tests via require().
 *
 * Input: mono Float32Array at SR (22050 Hz). Output: beats, bars and chord
 * labels as pitch classes. The main thread does the chord spelling.
 */
(function (root) {
  'use strict';

  const SR = 22050;

  // ---------- FFT (radix-2, in place) ----------
  const fftCache = new Map();
  function getFFT(n) {
    if (fftCache.has(n)) return fftCache.get(n);
    const bits = Math.log2(n) | 0;
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos(-2 * Math.PI * i / n);
      sin[i] = Math.sin(-2 * Math.PI * i / n);
    }
    const win = new Float64Array(n);
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    const re = new Float64Array(n), im = new Float64Array(n);
    const mag = new Float64Array(n / 2 + 1);
    function run() {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let start = 0; start < n; start += size) {
          for (let k = 0, t = 0; k < half; k++, t += step) {
            const a = start + k, b = a + half;
            const wr = cos[t], wi = sin[t];
            const xr = re[b] * wr - im[b] * wi;
            const xi = re[b] * wi + im[b] * wr;
            re[b] = re[a] - xr; im[b] = im[a] - xi;
            re[a] += xr; im[a] += xi;
          }
        }
      }
    }
    // Magnitude spectrum of the windowed frame starting at `offset`.
    function magnitude(x, offset) {
      for (let i = 0; i < n; i++) {
        const idx = offset + i;
        re[i] = (idx >= 0 && idx < x.length ? x[idx] : 0) * win[i];
        im[i] = 0;
      }
      run();
      for (let k = 0; k <= n / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
      return mag;
    }
    const f = { n, magnitude };
    fftCache.set(n, f);
    return f;
  }

  // ---------- helpers ----------
  function median(arr) {
    if (!arr.length) return 0;
    const s = Array.from(arr).sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
  }
  function percentile(arr, p) {
    if (!arr.length) return 0;
    const s = Array.from(arr).sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  }
  function mean(arr) { let s = 0; for (const v of arr) s += v; return arr.length ? s / arr.length : 0; }
  function std(arr) { const m = mean(arr); let s = 0; for (const v of arr) s += (v - m) * (v - m); return Math.sqrt(s / Math.max(1, arr.length)); }
  function zscore(arr) { const m = mean(arr), s = std(arr) || 1; return arr.map(v => (v - m) / s); }
  function norm2(v) { let s = 0; for (const x of v) s += x * x; return Math.sqrt(s); }
  function cosine(a, b) {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? d / Math.sqrt(na * nb) : 0;
  }

  // ---------- onset envelope ----------
  // Spectral flux on log magnitude. Returns full-band and low-band (<200 Hz) envelopes.
  const ON_N = 1024, ON_HOP = 256;
  function onsetEnvelope(x, progress) {
    const fft = getFFT(ON_N);
    const nFrames = Math.max(1, Math.floor((x.length - ON_N) / ON_HOP) + 1);
    const bins = ON_N / 2 + 1;
    const lowBin = Math.round(200 * ON_N / SR);
    let prev = new Float64Array(bins), cur = new Float64Array(bins);
    const env = new Float64Array(nFrames), low = new Float64Array(nFrames), rms = new Float64Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      const off = f * ON_HOP;
      const mag = fft.magnitude(x, off);
      let e = 0;
      for (let i = 0; i < ON_N; i++) { const v = x[off + i] || 0; e += v * v; }
      rms[f] = Math.sqrt(e / ON_N);
      let s = 0, sl = 0;
      for (let k = 1; k < bins; k++) {
        cur[k] = Math.log1p(100 * mag[k]);
        const d = cur[k] - prev[k];
        if (d > 0) { s += d; if (k <= lowBin) sl += d; }
      }
      env[f] = f ? s : 0; low[f] = f ? sl : 0;
      const t = prev; prev = cur; cur = t;
      if (progress && (f & 1023) === 0) progress(f / nFrames);
    }
    // Remove slow trend (local mean over ~1 s) and half-wave rectify.
    const detrend = (e) => {
      const w = Math.round(SR / ON_HOP / 2);
      const out = new Float64Array(e.length);
      let acc = 0;
      const pre = new Float64Array(e.length + 1);
      for (let i = 0; i < e.length; i++) { acc += e[i]; pre[i + 1] = acc; }
      for (let i = 0; i < e.length; i++) {
        const a = Math.max(0, i - w), b = Math.min(e.length, i + w + 1);
        const m = (pre[b] - pre[a]) / (b - a);
        out[i] = Math.max(0, e[i] - m);
      }
      const sd = std(out) || 1;
      for (let i = 0; i < out.length; i++) out[i] /= sd;
      return out;
    };
    return { env: detrend(env), low: detrend(low), rms, fps: SR / ON_HOP, offset: ON_N / 2 / SR };
  }

  // ---------- tempo ----------
  function autocorr(env, maxLag) {
    const n = env.length, ac = new Float64Array(maxLag + 1);
    for (let lag = 0; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
      ac[lag] = s / (n - lag);
    }
    return ac;
  }

  // Returns { bpm, period (frames), candidates }
  function estimateTempo(env, fps, opts) {
    opts = opts || {};
    const minBpm = opts.minBpm || 50, maxBpm = opts.maxBpm || 220;
    const prior = opts.priorBpm || 115;
    const maxLag = Math.ceil(fps * 60 / minBpm * 2) + 2;
    const ac = autocorr(env, Math.min(maxLag, env.length - 1));
    const at = (lag) => {
      if (lag >= ac.length - 1) return 0;
      const i = Math.floor(lag), fr = lag - i;
      return ac[i] * (1 - fr) + ac[i + 1] * fr;
    };
    const cands = [];
    for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.25) {
      const lag = fps * 60 / bpm;
      // Harmonic reinforcement: a true beat period also shows at 2x and 4x the lag.
      const raw = at(lag) + 0.5 * at(2 * lag) + 0.25 * at(4 * lag) + 0.25 * at(lag / 2);
      const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / prior) / 0.9, 2));
      cands.push({ bpm, score: raw * w, raw });
    }
    let best = cands[0];
    for (const c of cands) if (c.score > best.score) best = c;
    // Local refinement at 0.05 BPM.
    let bestBpm = best.bpm, bestScore = -Infinity;
    for (let bpm = best.bpm - 0.5; bpm <= best.bpm + 0.5; bpm += 0.05) {
      const lag = fps * 60 / bpm;
      const s = at(lag) + 0.5 * at(2 * lag) + 0.25 * at(4 * lag);
      if (s > bestScore) { bestScore = s; bestBpm = bpm; }
    }
    return { bpm: bestBpm, period: fps * 60 / bestBpm };
  }

  // ---------- beat tracking (dynamic programming, Ellis 2007) ----------
  function trackBeats(env, period, tightness) {
    tightness = tightness || 100;
    const n = env.length;
    // Smooth the onset envelope with a Gaussian of width ~period/32.
    const half = Math.round(period);
    const kern = [];
    for (let i = -half; i <= half; i++) kern.push(Math.exp(-0.5 * Math.pow(i * 32 / period, 2)));
    const local = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -half; k <= half; k++) { const j = i + k; if (j >= 0 && j < n) s += env[j] * kern[k + half]; }
      local[i] = s;
    }
    const cum = new Float64Array(n), back = new Int32Array(n).fill(-1);
    const lo = Math.round(period / 2), hi = Math.round(2 * period);
    const tx = new Float64Array(hi + 1);
    for (let d = lo; d <= hi; d++) tx[d] = -tightness * Math.pow(Math.log(d / period), 2);
    for (let i = 0; i < n; i++) {
      let best = -Infinity, bi = -1;
      for (let d = lo; d <= hi; d++) {
        const j = i - d;
        if (j < 0) break;
        const s = cum[j] + tx[d];
        if (s > best) { best = s; bi = j; }
      }
      cum[i] = local[i] + (bi >= 0 ? best : 0);
      back[i] = bi;
    }
    // Last beat: the last local maximum of cum that is reasonably strong.
    const maxes = [];
    for (let i = 1; i < n - 1; i++) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) maxes.push(i);
    let last = n - 1;
    if (maxes.length) {
      const thr = 0.5 * median(maxes.map(i => cum[i]));
      for (let k = maxes.length - 1; k >= 0; k--) if (cum[maxes[k]] >= thr) { last = maxes[k]; break; }
    }
    const beats = [];
    for (let i = last; i >= 0; i = back[i]) beats.push(i);
    beats.reverse();
    return { beats, local };
  }

  // Snap each beat to the nearest onset peak (a few frames), then refit gently.
  function refineBeats(frames, env) {
    return frames.map(f => {
      let best = f, bv = env[f] || 0;
      for (let d = -2; d <= 2; d++) {
        const j = f + d;
        if (j >= 0 && j < env.length && env[j] > bv) { bv = env[j]; best = j; }
      }
      // Parabolic interpolation for sub-frame accuracy.
      const a = env[best - 1] || 0, b = env[best] || 0, c = env[best + 1] || 0;
      const den = a - 2 * b + c;
      const off = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
      return best + off;
    });
  }

  // ---------- chroma ----------
  const CH_N = 8192, CH_HOP = 2048;
  function chromaFrames(x, progress) {
    const fft = getFFT(CH_N);
    const nFrames = Math.max(1, Math.floor((x.length - CH_N / 2) / CH_HOP) + 1);
    const bins = CH_N / 2 + 1;
    const fmin = 38, fmax = 2600, bassMax = 230, trebleMin = 120;
    const kmin = Math.ceil(fmin * CH_N / SR), kmax = Math.floor(fmax * CH_N / SR);
    const treble = [], bass = [], energy = new Float64Array(nFrames);
    const peaks = []; // for tuning: deviations in cents (weighted)
    const deviations = [];
    // Pass 1: collect peaks per frame (freq, mag), estimate tuning.
    const framePeaks = new Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      const off = f * CH_HOP - CH_N / 2;
      const mag = fft.magnitude(x, off);
      let mx = 0, e = 0;
      for (let k = kmin; k <= kmax; k++) { if (mag[k] > mx) mx = mag[k]; e += mag[k] * mag[k]; }
      energy[f] = Math.sqrt(e);
      const list = [];
      const thr = mx * 0.01;
      for (let k = kmin; k <= kmax; k++) {
        const m = mag[k];
        if (m > thr && m > mag[k - 1] && m >= mag[k + 1]) {
          const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(m + 1e-12), c = Math.log(mag[k + 1] + 1e-12);
          const den = a - 2 * b + c;
          const p = den < 0 ? 0.5 * (a - c) / den : 0;
          const freq = (k + p) * SR / CH_N;
          list.push(freq, m);
          if (m > mx * 0.1 && freq > 80 && freq < 2000) {
            const midi = 69 + 12 * Math.log2(freq / 440);
            deviations.push(midi - Math.round(midi), m);
          }
        }
      }
      framePeaks[f] = list;
      if (progress && (f & 127) === 0) progress(0.5 * f / nFrames);
    }
    // Tuning: circular mean of deviations (in semitones), weighted by magnitude.
    let sx = 0, sy = 0;
    for (let i = 0; i < deviations.length; i += 2) {
      const ang = 2 * Math.PI * deviations[i];
      sx += Math.cos(ang) * deviations[i + 1]; sy += Math.sin(ang) * deviations[i + 1];
    }
    const tuning = deviations.length ? Math.atan2(sy, sx) / (2 * Math.PI) : 0; // semitones, -0.5..0.5
    // Pass 2: map peaks to chroma.
    for (let f = 0; f < nFrames; f++) {
      const t = new Float64Array(12), b = new Float64Array(12);
      const list = framePeaks[f];
      for (let i = 0; i < list.length; i += 2) {
        const freq = list[i], m = Math.sqrt(list[i + 1]);
        const midi = 69 + 12 * Math.log2(freq / 440) - tuning;
        const r = Math.round(midi), dev = midi - r;
        const w = m * Math.pow(Math.cos(Math.PI * dev), 2);
        const pc = ((r % 12) + 12) % 12;
        if (freq <= bassMax) b[pc] += w * (freq < 60 ? 0.6 : 1);
        if (freq >= trebleMin) t[pc] += w;
      }
      treble.push(t); bass.push(b);
      framePeaks[f] = null;
      if (progress && (f & 127) === 0) progress(0.5 + 0.5 * f / nFrames);
    }
    return { treble, bass, energy, fps: SR / CH_HOP, tuning };
  }

  // Average chroma between consecutive boundary times (seconds).
  function syncChroma(frames, fps, bounds) {
    const out = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const a = Math.max(0, Math.round(bounds[i] * fps)), b = Math.max(a + 1, Math.round(bounds[i + 1] * fps));
      const v = new Float64Array(12);
      let cnt = 0;
      for (let f = a; f < b && f < frames.length; f++) { for (let k = 0; k < 12; k++) v[k] += frames[f][k]; cnt++; }
      if (cnt) for (let k = 0; k < 12; k++) v[k] /= cnt;
      out.push(v);
    }
    return out;
  }

  // ---------- chord templates ----------
  const QUALITIES = {
    '': [0, 4, 7],
    'm': [0, 3, 7],
    '7': [0, 4, 7, 10],
    'm7': [0, 3, 7, 10],
    'maj7': [0, 4, 7, 11],
  };
  // Each note brings its harmonics: 1st..6th partials fold to 0, 0, +7, 0, +4, +7 semitones.
  const HARM = [[0, 1], [0, 0.6], [7, 0.36], [0, 0.22], [4, 0.13], [7, 0.08]];
  function template(rootPc, intervals) {
    const t = new Float64Array(12);
    for (const iv of intervals) for (const [h, w] of HARM) t[(rootPc + iv + h) % 12] += w;
    const n = norm2(t);
    for (let i = 0; i < 12; i++) t[i] /= n;
    return t;
  }

  function buildChordSet(withSevenths) {
    const quals = withSevenths ? ['', 'm', '7', 'm7', 'maj7'] : ['', 'm'];
    const set = [];
    for (const q of quals) for (let r = 0; r < 12; r++) {
      set.push({ root: r, quality: q, tpl: template(r, QUALITIES[q]), tones: QUALITIES[q].map(i => (r + i) % 12), penalty: q.length && q !== 'm' ? 0.035 : 0 });
    }
    return set;
  }

  // ---------- key ----------
  // Krumhansl–Kessler profiles.
  const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function pearson(a, b) {
    const ma = mean(a), mb = mean(b);
    let n = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return da && db ? n / Math.sqrt(da * db) : 0;
  }
  function profileKeyScores(chroma) {
    const scores = [];
    for (let t = 0; t < 12; t++) {
      const rot = (p) => { const r = new Array(12); for (let i = 0; i < 12; i++) r[(i + t) % 12] = p[i]; return r; };
      scores.push({ tonic: t, minor: false, score: pearson(chroma, rot(KK_MAJ)) });
      scores.push({ tonic: t, minor: true, score: pearson(chroma, rot(KK_MIN)) });
    }
    return scores;
  }
  // Diatonic chord roles for a key: returns map "pc|quality-class" -> weight.
  function diatonicWeights(tonic, minor) {
    const w = new Map();
    const add = (deg, q, v) => w.set(((tonic + deg) % 12) + '|' + q, v);
    if (!minor) {
      add(0, 'M', 1.0); add(5, 'M', 0.8); add(7, 'M', 0.8); add(9, 'm', 0.6); add(2, 'm', 0.55); add(4, 'm', 0.5);
      add(10, 'M', 0.25); // bVII, common in rock
    } else {
      add(0, 'm', 1.0); add(5, 'm', 0.7); add(7, 'M', 0.6); add(7, 'm', 0.5); add(8, 'M', 0.7); add(10, 'M', 0.7); add(3, 'M', 0.7);
    }
    return w;
  }
  const qclass = (q) => (q === 'm' || q === 'm7') ? 'm' : 'M';

  function chooseKey(globalChroma, beatChords, chordSet) {
    const prof = profileKeyScores(globalChroma);
    const counts = new Map();
    let total = 0;
    for (const c of beatChords) {
      if (c < 0) continue;
      const ch = chordSet[c];
      const k = ch.root + '|' + qclass(ch.quality);
      counts.set(k, (counts.get(k) || 0) + 1); total++;
    }
    const first = beatChords.find(c => c >= 0), last = [...beatChords].reverse().find(c => c >= 0);
    let best = null;
    for (const p of prof) {
      const w = diatonicWeights(p.tonic, p.minor);
      let s = 0;
      for (const [k, n] of counts) s += (w.get(k) || 0) * n;
      s = total ? s / total : 0;
      const tonicKey = p.tonic + '|' + (p.minor ? 'm' : 'M');
      let bonus = 0;
      if (first !== undefined && (chordSet[first].root + '|' + qclass(chordSet[first].quality)) === tonicKey) bonus += 0.08;
      if (last !== undefined && (chordSet[last].root + '|' + qclass(chordSet[last].quality)) === tonicKey) bonus += 0.08;
      const score = 0.6 * p.score + s + bonus;
      if (!best || score > best.score) best = { tonic: p.tonic, minor: p.minor, score };
    }
    return best;
  }

  // ---------- chord decoding (Viterbi over beats) ----------
  // emit[i][s] = log-likelihood of state s at beat i. changeCost[i] = cost to change chord entering beat i.
  function viterbi(emit, changeCost) {
    const T = emit.length; if (!T) return [];
    const S = emit[0].length;
    let prev = Float64Array.from(emit[0]);
    const back = [];
    for (let t = 1; t < T; t++) {
      let bestPrev = -Infinity, bpi = 0;
      for (let s = 0; s < S; s++) if (prev[s] > bestPrev) { bestPrev = prev[s]; bpi = s; }
      const cur = new Float64Array(S), bk = new Int32Array(S);
      for (let s = 0; s < S; s++) {
        const stay = prev[s], jump = bestPrev - changeCost[t];
        if (stay >= jump) { cur[s] = stay + emit[t][s]; bk[s] = s; }
        else { cur[s] = jump + emit[t][s]; bk[s] = bpi; }
      }
      back.push(bk); prev = cur;
    }
    let s = 0;
    for (let i = 1; i < S; i++) if (prev[i] > prev[s]) s = i;
    const path = new Array(T);
    path[T - 1] = s;
    for (let t = T - 1; t > 0; t--) { s = back[t - 1][s]; path[t - 1] = s; }
    return path;
  }

  function emissions(beatTreble, beatBass, beatLoud, chordSet, keyInfo) {
    const kappa = 14;
    const kw = keyInfo ? diatonicWeights(keyInfo.tonic, keyInfo.minor) : null;
    return beatTreble.map((t, i) => {
      const b = beatBass[i];
      const bsum = b.reduce((a, v) => a + v, 0) || 1;
      const row = new Float64Array(chordSet.length + 1);
      for (let s = 0; s < chordSet.length; s++) {
        const ch = chordSet[s];
        let sc = cosine(t, ch.tpl) - ch.penalty;
        // Bass support: root in the bass is likely; another chord tone in the bass is fine too.
        sc += 0.18 * (b[ch.root] / bsum);
        if (kw) sc += 0.04 * (kw.get(ch.root + '|' + qclass(ch.quality)) || 0);
        row[s] = kappa * sc;
      }
      // No-chord state: wins only when the beat is near silent.
      row[chordSet.length] = beatLoud[i] < 0.06 ? kappa * 2 : -kappa * 2;
      return row;
    });
  }

  // ---------- downbeats ----------
  function chooseDownbeatPhase(beatTreble, beatLow, beatOnset, bpb, chordPath) {
    const n = beatTreble.length;
    if (bpb < 2 || n < bpb * 2) return { phase: 0, contrast: 0 };
    // Harmonic change entering beat i: compare 2 beats before vs 2 beats after.
    const change = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const a = new Float64Array(12), b = new Float64Array(12);
      for (let k = Math.max(0, i - 2); k < i; k++) for (let j = 0; j < 12; j++) a[j] += beatTreble[k][j];
      for (let k = i; k < Math.min(n, i + 2); k++) for (let j = 0; j < 12; j++) b[j] += beatTreble[k][j];
      change[i] = 1 - cosine(a, b);
    }
    const labelChange = new Array(n).fill(0);
    if (chordPath) for (let i = 1; i < n; i++) labelChange[i] = chordPath[i] !== chordPath[i - 1] ? 1 : 0;
    const zc = zscore(change), zl = zscore(beatLow), zo = zscore(beatOnset), zlc = zscore(labelChange);
    const score = new Array(bpb).fill(0), cnt = new Array(bpb).fill(0);
    for (let i = 0; i < n; i++) {
      const p = i % bpb;
      score[p] += zc[i] + 0.9 * zlc[i] + 0.5 * zl[i] + 0.2 * zo[i];
      cnt[p]++;
    }
    for (let p = 0; p < bpb; p++) score[p] /= cnt[p] || 1;
    let best = 0;
    for (let p = 1; p < bpb; p++) if (score[p] > score[best]) best = p;
    return { phase: best, contrast: score[best] - mean(score), scores: score };
  }

  // ---------- section suggestions ----------
  function suggestSections(barChords, phraseLen) {
    phraseLen = phraseLen || 4;
    const phrases = [];
    for (let i = 0; i < barChords.length; i += phraseLen) phrases.push(barChords.slice(i, i + phraseLen));
    const sim = (a, b) => {
      const n = Math.max(a.length, b.length); let same = 0;
      for (let i = 0; i < n; i++) if (a[i] === b[i]) same++;
      return same / n;
    };
    const reps = []; const letters = [];
    for (const p of phrases) {
      let idx = reps.findIndex(r => sim(r, p) >= 0.75);
      if (idx < 0) { reps.push(p); idx = reps.length - 1; }
      letters.push(idx);
    }
    const sections = [];
    for (let i = 0; i < letters.length; i++) {
      if (i === 0 || letters[i] !== letters[i - 1]) sections.push({ bar: i * phraseLen, group: letters[i] });
      else if (i >= 2 && letters[i - 1] === letters[i] && letters[i - 2] === letters[i] && sections.length && (i * phraseLen - sections[sections.length - 1].bar) >= 4 * phraseLen) {
        // A long run of the same phrase: split every 4 phrases so charts stay readable.
        sections.push({ bar: i * phraseLen, group: letters[i] });
      }
    }
    return sections;
  }

  // ---------- full pipeline ----------
  function analyze(x, opts, progress) {
    opts = opts || {};
    const report = (stage, frac) => progress && progress(stage, frac);
    const bpbOpt = opts.beatsPerBar || 4;

    // Normalize level.
    let peak = 0;
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
    if (peak > 0 && peak !== 1) { const g = 1 / peak; const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] * g; x = y; }

    report('Finding the beat', 0);
    const on = onsetEnvelope(x, f => report('Finding the beat', f * 0.8));
    let tempo;
    if (opts.bpm) tempo = { bpm: opts.bpm, period: on.fps * 60 / opts.bpm };
    else {
      // Kick drum and bass usually mark the beat; hi-hats often mark eighths.
      const mix = on.env.map((v, i) => v + 1.5 * on.low[i]);
      tempo = estimateTempo(mix, on.fps, { priorBpm: opts.priorBpm });
    }
    const tb = trackBeats(on.env, tempo.period, opts.tightness || 100);
    let frames = refineBeats(tb.beats, on.env);

    // Trim beats in silence at the start and end.
    const loudRef = percentile(Array.from(on.rms), 0.95) || 1;
    const rmsAt = (f) => { const i = Math.round(f); let m = 0; for (let k = i - 4; k <= i + 4; k++) if (on.rms[k] > m) m = on.rms[k]; return m / loudRef; };
    while (frames.length > 2 && rmsAt(frames[0]) < 0.03) frames.shift();
    while (frames.length > 2 && rmsAt(frames[frames.length - 1]) < 0.03) frames.pop();
    let beats = frames.map(f => f / on.fps + on.offset);
    report('Finding the beat', 1);

    // Tempo from the tracked beats (median inter-beat interval).
    const ibis = []; for (let i = 1; i < beats.length; i++) ibis.push(beats[i] - beats[i - 1]);
    const ibi = median(ibis) || 60 / tempo.bpm;

    report('Listening for chords', 0);
    const ch = chromaFrames(x, f => report('Listening for chords', f));
    // Beat segments: each beat runs to the next; extend the final beat by one interval.
    const bounds = beats.concat([beats[beats.length - 1] + ibi]);
    const bt = syncChroma(ch.treble, ch.fps, bounds);
    const bb = syncChroma(ch.bass, ch.fps, bounds);
    const loud = bounds.slice(0, -1).map((t, i) => {
      const a = Math.round(t * on.fps), b = Math.round(bounds[i + 1] * on.fps);
      let m = 0; for (let f = a; f < b && f < on.rms.length; f++) m = Math.max(m, on.rms[f]);
      return m / loudRef;
    });
    const beatOnset = beats.map(t => { const f = Math.round((t - on.offset) * on.fps); let m = 0; for (let k = f - 2; k <= f + 2; k++) m = Math.max(m, on.env[k] || 0); return m; });
    const beatLow = beats.map(t => { const f = Math.round((t - on.offset) * on.fps); let m = 0; for (let k = f - 2; k <= f + 2; k++) m = Math.max(m, on.low[k] || 0); return m; });

    const chordSet = buildChordSet(!!opts.sevenths);
    const NC = chordSet.length;
    const nb = bt.length;

    // Pass 1: chords with a flat change cost, no key.
    const flatCost = new Array(nb).fill(9);
    const path1 = viterbi(emissions(bt, bb, loud, chordSet, null), flatCost).map(s => s === NC ? -1 : s);

    // Downbeats (and optional 3 vs 4 detection).
    let bpb = bpbOpt;
    let db = chooseDownbeatPhase(bt, beatLow, beatOnset, bpb, path1);
    if (opts.detectMeter) {
      const d3 = chooseDownbeatPhase(bt, beatLow, beatOnset, 3, path1);
      const d4 = chooseDownbeatPhase(bt, beatLow, beatOnset, 4, path1);
      if (d3.contrast > d4.contrast * 1.25) { bpb = 3; db = d3; } else { bpb = 4; db = d4; }
    }

    // Key.
    const global = new Float64Array(12);
    bt.forEach((v, i) => { const s = v.reduce((a, c) => a + c, 0) || 1; for (let k = 0; k < 12; k++) global[k] += v[k] / s * loud[i]; });
    const key = chooseKey(Array.from(global), path1, chordSet);

    // Pass 2: chords with key prior and metrical change costs.
    const cost = new Array(nb).fill(0).map((_, i) => {
      const pos = ((i - db.phase) % bpb + bpb) % bpb;
      if (pos === 0) return 4;                              // bar line: cheap
      if (bpb % 2 === 0 && pos === bpb / 2) return 7;      // half bar
      return 13;                                           // other beats: rare
    });
    const path = viterbi(emissions(bt, bb, loud, chordSet, key), cost).map(s => s === NC ? -1 : s);

    // Bars.
    const bars = [];
    const startBeat = db.phase;
    if (startBeat > 0) {
      // Pickup: a bar that starts before the first full bar (extrapolated), kept if it has music.
      const t0 = beats[startBeat] - bpb * ibi;
      bars.push({ start: Math.max(0, t0), beats: Array.from({ length: startBeat }, (_, k) => k), pickup: true });
    }
    for (let i = startBeat; i < nb; i += bpb) {
      const idx = [];
      for (let k = i; k < Math.min(nb, i + bpb); k++) idx.push(k);
      bars.push({ start: beats[i], beats: idx });
    }

    // Bass for slash chords, per chord segment.
    const segBass = (from, to, chord) => {
      const acc = new Float64Array(12);
      for (let k = from; k < to; k++) { const s = bb[k].reduce((a, v) => a + v, 0) || 1; for (let j = 0; j < 12; j++) acc[j] += bb[k][j] / s; }
      let top = 0; for (let j = 1; j < 12; j++) if (acc[j] > acc[top]) top = j;
      const ch = chordSet[chord];
      if (top !== ch.root && acc[top] > 1.6 * acc[ch.root] && acc[top] / (to - from) > 0.3) return top;
      return -1;
    };

    // Per-beat labels -> per-bar text items: [{root, quality, bass}] (1 or 2 items).
    const label = (s, bass) => s < 0 ? { nc: true } : { root: chordSet[s].root, quality: chordSet[s].quality, bass: bass };
    // Slash bass decided over whole chord segments (runs of the same label).
    const beatBassNote = new Array(nb).fill(-1);
    if (opts.slash !== false) {
      let i = 0;
      while (i < nb) {
        let j = i; while (j < nb && path[j] === path[i]) j++;
        if (path[i] >= 0 && j - i >= 2) { const b = segBass(i, j, path[i]); for (let k = i; k < j; k++) beatBassNote[k] = b; }
        i = j;
      }
    }
    const mode = (arr) => { const m = new Map(); let best = null, bc = 0; for (const v of arr) { const c = (m.get(v) || 0) + 1; m.set(v, c); if (c > bc) { bc = c; best = v; } } return { v: best, c: bc }; };
    const key2 = (k) => path[k] + ':' + beatBassNote[k];
    const barItems = bars.map(bar => {
      const ks = bar.beats;
      if (!ks.length) return [];
      const ids = ks.map(key2);
      const len = ks.length;
      const toItem = (id) => { const [s, b] = id.split(':').map(Number); return label(s, b); };
      if (len >= 2 && len % 2 === 0 && !bar.pickup) {
        const h = len / 2;
        const A = mode(ids.slice(0, h)), B = mode(ids.slice(h));
        if (A.v !== B.v && A.c === h && B.c === h) return [toItem(A.v), toItem(B.v)];
      }
      return [toItem(mode(ids).v)];
    });

    // Drop leading/trailing no-chord bars.
    let a = 0, b = bars.length;
    while (a < b && barItems[a].every(it => it.nc)) a++;
    while (b > a && barItems[b - 1].every(it => it.nc)) b--;
    const outBars = bars.slice(a, b).map((bar, i) => ({ start: bar.start, items: barItems[a + i] }));

    const sig = outBars.map(b2 => b2.items.map(it => it.nc ? 'N' : it.root + it.quality + '/' + it.bass).join(' '));
    // For section grouping, a bar that just continues the previous chord matches anything equal.
    const sections = opts.sections === false ? [] : suggestSections(sig, 4);

    const bpm = 60 / ibi;
    return {
      bpm, beatsPerBar: bpb, beats, downbeatPhase: db.phase,
      key: { tonic: key.tonic, minor: key.minor },
      tuningCents: Math.round(ch.tuning * 100),
      bars: outBars, sections,
      duration: x.length / SR,
    };
  }

  const api = { SR, analyze, estimateTempo, trackBeats, onsetEnvelope, chromaFrames, buildChordSet, chooseKey, profileKeyScores, viterbi, suggestSections, median };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ACDSP = api;
})(typeof self !== 'undefined' ? self : this);
