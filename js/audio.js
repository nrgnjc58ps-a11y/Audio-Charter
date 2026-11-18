// Audio: decoding, waveform peaks, playback (slow-down keeps pitch), click track, recording.

import { extractAac } from './mp4audio.js';

export const ANALYSIS_SR = 22050;
let ctx = null;

export function audioContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
  }
  return ctx;
}

/** Call from a user gesture (iOS needs this before any Web Audio sound). */
export function unlockAudio() {
  try {
    const c = audioContext();
    if (c.state !== 'running') c.resume();
  } catch { /* ignore */ }
}

function decode(arrayBuffer) {
  const c = audioContext();
  return new Promise((resolve, reject) => {
    const p = c.decodeAudioData(arrayBuffer, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

/** Mono Float32Array at ANALYSIS_SR. */
async function toMono22k(buf) {
  const len = Math.ceil(buf.duration * ANALYSIS_SR);
  try {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new OAC(1, len, ANALYSIS_SR);
    const src = off.createBufferSource();
    src.buffer = buf; src.connect(off.destination); src.start();
    const out = await off.startRendering();
    return out.getChannelData(0).slice();
  } catch {
    // Fallback: average channels, then box-filter + linear resample.
    const ch = buf.numberOfChannels, n = buf.length, mono = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
    const ratio = buf.sampleRate / ANALYSIS_SR, out = new Float32Array(len);
    const w = Math.max(1, Math.floor(ratio));
    for (let i = 0; i < len; i++) {
      const s = Math.floor(i * ratio); let acc = 0, k = 0;
      for (let j = 0; j < w && s + j < n; j++, k++) acc += mono[s + j];
      out[i] = k ? acc / k : 0;
    }
    return out;
  }
}

/** Min/max per bucket, PEAK_RATE buckets per second. */
export const PEAK_RATE = 100;
function computePeaks(mono) {
  const per = ANALYSIS_SR / PEAK_RATE, n = Math.ceil(mono.length / per);
  const min = new Float32Array(n), max = new Float32Array(n);
  let top = 0;
  for (let b = 0; b < n; b++) {
    let lo = 0, hi = 0;
    const a = Math.floor(b * per), e = Math.min(mono.length, Math.floor((b + 1) * per));
    for (let i = a; i < e; i++) { const v = mono[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    min[b] = lo; max[b] = hi; top = Math.max(top, -lo, hi);
  }
  if (top > 0) for (let b = 0; b < n; b++) { min[b] /= top; max[b] /= top; }
  return { min, max };
}

/** Decodes a Blob into { mono, peaks, duration }. */
/**
 * Decodes a Blob into { mono, peaks, duration }.
 * Videos (e.g. iPhone screen recordings): Safari won't decode their sound directly,
 * so if that fails the AAC soundtrack is copied out of the MP4/MOV and decoded instead.
 */
export async function loadAudio(blob) {
  const ab = await blob.arrayBuffer();
  let buf, skip = 0;
  try {
    buf = await decode(ab.slice(0)); // decodeAudioData may detach the buffer it is given
  } catch (err) {
    const aac = extractAac(ab);
    if (!aac) throw err;
    buf = await decode(aac.data.buffer);
    skip = aac.skipSeconds;
  }
  let mono = await toMono22k(buf);
  if (skip > 0) mono = mono.slice(Math.round(skip * ANALYSIS_SR));
  return { mono, peaks: computePeaks(mono), duration: mono.length / ANALYSIS_SR };
}

export class Player {
  constructor() {
    this.el = document.createElement('audio');
    this.el.preload = 'auto';
    this.el.setAttribute('playsinline', '');
    this.setPreservePitch();
    this.url = null;
    this.rate = 1;
    document.body.appendChild(this.el);
  }
  setPreservePitch() {
    const el = this.el;
    if ('preservesPitch' in el) el.preservesPitch = true;
    if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = true;
    if ('mozPreservesPitch' in el) el.mozPreservesPitch = true;
  }
  load(blob) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    this.el.src = this.url;
    this.el.load();
  }
  get time() { return this.el.currentTime || 0; }
  get playing() { return !this.el.paused; }
  get duration() { return this.el.duration || 0; }
  play() { this.setPreservePitch(); this.el.playbackRate = this.rate; return this.el.play().catch(() => {}); }
  pause() { this.el.pause(); }
  seek(t) { this.el.currentTime = Math.max(0, Math.min(t, (this.el.duration || t) - 0.01)); }
  setRate(r) { this.rate = r; this.el.playbackRate = r; this.setPreservePitch(); }
}

/** Metronome click scheduled against the audio element's clock. */
export class Clicker {
  constructor() { this.enabled = false; this.next = -1; }
  reset() { this.next = -1; }
  /** beats: sorted [{t, accent}]; songTime: current; rate: playback rate. */
  tick(beats, songTime, rate) {
    if (!this.enabled || !beats.length) return;
    const c = audioContext();
    const ahead = 0.12 * rate;
    if (this.next < 0 || this.next < songTime - 0.3) this.next = songTime;
    for (const b of beats) {
      if (b.t < this.next || b.t > songTime + ahead) continue;
      const when = c.currentTime + Math.max(0, (b.t - songTime) / rate);
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.value = b.accent ? 1760 : 1100;
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(b.accent ? 0.5 : 0.3, when + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
      o.connect(g); g.connect(c.destination);
      o.start(when); o.stop(when + 0.06);
      this.next = b.t + 1e-4;
    }
    this.next = Math.max(this.next, songTime + ahead);
  }
}

/** Microphone recorder. */
export class Recorder {
  static supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder); }
  async start(onLevel) {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
    const type = types.find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
    this.rec = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    // One continuous file (no timeslice): fragmented chunks decode badly in some browsers.
    this.rec.start();
    this.t0 = performance.now();
    try {
      const c = audioContext();
      const src = c.createMediaStreamSource(this.stream);
      const an = c.createAnalyser(); an.fftSize = 1024; src.connect(an);
      const data = new Float32Array(an.fftSize);
      const loop = () => {
        if (!this.rec || this.rec.state !== 'recording') return;
        an.getFloatTimeDomainData(data);
        let pk = 0; for (const v of data) pk = Math.max(pk, Math.abs(v));
        onLevel && onLevel(pk, (performance.now() - this.t0) / 1000);
        requestAnimationFrame(loop);
      };
      loop();
    } catch { /* level meter is optional */ }
  }
  stop() {
    return new Promise((resolve) => {
      const rec = this.rec;
      if (!rec) { resolve(null); return; }
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: rec.mimeType || 'audio/mp4' });
        this.stream.getTracks().forEach(t => t.stop());
        this.rec = null;
        resolve(blob);
      };
      rec.stop();
    });
  }
  cancel() {
    if (this.rec && this.rec.state !== 'inactive') { this.rec.onstop = null; this.rec.stop(); }
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.rec = null;
  }
}
