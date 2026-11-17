// Audio Charter — main UI.
import { Player, Clicker, Recorder, loadAudio, unlockAudio, PEAK_RATE } from './audio.js';
import { store } from './store.js';
import { toBackup, backupFileName, sectionRanges, uid } from './export.js';
import {
  MAJOR_KEYS, MINOR_KEYS, keyName, normalizeBar, normalizeChord, respellBar, chordName,
  diatonicChords, borrowedChords, isChordToken, spellingFor, lastChordOf, parseChord,
} from './chords.js';

// ---------------------------------------------------------------- constants
const TIME_SIGS = ['4/4', '3/4', '2/4', '2/2', '6/8', '12/8', '5/4', '7/8'];
const SECTION_NAMES = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Post-Chorus', 'Bridge', 'Solo', 'Instrumental', 'Interlude', 'Break', 'Outro', 'Tag', 'Coda'];
// Same set and spelling as Chart Maker's chord keyboard.
const QUALS = [['', 'maj'], ['-', '-'], ['7', '7'], ['-7', '-7'], ['Δ7', 'Δ7'], ['ø7', 'ø7'], ['°7', '°7'], ['5', '5'], ['sus4', 'sus4'], ['sus2', 'sus2'], ['7sus4', '7sus4'], ['add9', 'add9'], ['6', '6'], ['9', '9'], ['°', '°'], ['+', '+']];

export function beatsPerBar(time) {
  const [n, d] = String(time || '4/4').split('/').map(Number);
  if (d === 8 && n % 3 === 0 && n > 3) return n / 3; // compound: tap dotted quarters
  return n || 4;
}

// ---------------------------------------------------------------- state
const $ = (id) => document.getElementById(id);
const S = {
  project: null,
  audio: null,        // { mono, peaks, duration }
  blob: null,
  sel: 0, selAnchor: 0, selEnd: 0,
  loopOn: false,
  taps: [], tapMode: 'beats', lastTapAt: 0,
  undo: [],
  typingBar: -1,
  builder: null,      // { bar, part }
  dirty: true,
  curBar: -1,
  analyzing: false,
};
const player = new Player();
const clicker = new Clicker();
let recorder = null;

// ---------------------------------------------------------------- utilities
function fmtTime(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, ms);
}
function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function duration() { return (S.audio && S.audio.duration) || player.duration || S.project?.duration || 0; }
const P = () => S.project;
const bpb = () => beatsPerBar(P()?.time);
function barEnd(i) { const b = P().bars; return i + 1 < b.length ? b[i + 1].t : Math.max(b[i].t + 0.5, duration()); }
function barAt(t) {
  const b = P()?.bars; if (!b || !b.length || t < b[0].t) return -1;
  let lo = 0, hi = b.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (b[mid].t <= t) lo = mid; else hi = mid - 1; }
  return lo;
}
function allBeats() {
  const out = [], n = bpb(), bars = P()?.bars || [];
  bars.forEach((bar, i) => {
    const e = barEnd(i), d = (e - bar.t) / n;
    for (let k = 0; k < n; k++) out.push({ t: bar.t + k * d, accent: k === 0, bar: i });
  });
  return out;
}
function selRange() { return [Math.min(S.selAnchor, S.selEnd), Math.max(S.selAnchor, S.selEnd)]; }
function effectiveChordBefore(i) {
  const b = P().bars;
  for (let k = i - 1; k >= 0; k--) { const c = lastChordOf(normalizeBar(b[k].chord)); if (c) return c; }
  return '';
}

// ---------------------------------------------------------------- persistence & undo
let saveTimer = null;
function save() {
  const p = P(); if (!p) return;
  p.updated = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.save(p), 400);
}
function snapshot() { const p = P(); return JSON.stringify({ bars: p.bars, sections: p.sections, key: p.key, time: p.time, tempo: p.tempo }); }
function pushUndo() {
  S.undo.push(snapshot());
  if (S.undo.length > 80) S.undo.shift();
  $('btnUndo').disabled = false;
}
function undo() {
  const s = S.undo.pop(); if (!s) return;
  Object.assign(P(), JSON.parse(s));
  $('btnUndo').disabled = !S.undo.length;
  clampSel(); changed(); syncSongFields();
  toast('Undone');
}
function changed() { save(); renderBars(); renderPalettes(); S.dirty = true; }
function clampSel() {
  const n = P().bars.length;
  S.sel = Math.max(0, Math.min(S.sel, n - 1));
  S.selAnchor = Math.max(0, Math.min(S.selAnchor, n - 1));
  S.selEnd = Math.max(0, Math.min(S.selEnd, n - 1));
}

// ---------------------------------------------------------------- views
function show(view) {
  $('home').hidden = view !== 'home';
  $('editor').hidden = view !== 'editor';
  if (view === 'home') { player.pause(); renderLibrary(); }
  if (view === 'editor') { resizeCanvases(); S.dirty = true; }
}

async function renderLibrary() {
  const list = await store.list();
  const ul = $('libraryList');
  ul.innerHTML = '';
  $('libraryEmpty').hidden = list.length > 0;
  $('btnExportAll').hidden = list.length === 0;
  for (const p of list) {
    const li = document.createElement('li');
    li.className = 'lib-item';
    const bits = [p.bars.length + ' bars'];
    if (p.key) bits.push(p.key);
    if (p.tempo) bits.push(Math.round(p.tempo) + ' BPM');
    bits.push(new Date(p.updated).toLocaleDateString());
    li.innerHTML = `<input type="checkbox" aria-label="Select for export"><button class="open" type="button"><strong></strong><small></small></button>`;
    li.querySelector('strong').textContent = p.title || 'Untitled';
    li.querySelector('small').textContent = bits.join(' · ');
    li.querySelector('input').dataset.id = p.id;
    li.querySelector('.open').addEventListener('click', () => openProject(p.id));
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------- loading
function newProject(name, dur) {
  return {
    id: uid(), chartId: uid(),
    title: (name || 'Untitled').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').trim(),
    composer: '', key: '', time: '4/4', tempo: null,
    bars: [], sections: [],
    audioName: name || '', duration: dur || 0,
    created: Date.now(), updated: Date.now(),
    tapLatency: 40,
  };
}

async function openAudioBlob(blob, name) {
  unlockAudio();
  show('editor');
  $('loading').hidden = false;
  $('loading').querySelector('span').textContent = 'Loading audio…';
  // Save first, so a recording is never lost even if this phone can't decode it.
  const p = newProject(name, 0);
  store.save(p);
  store.saveAudio(p.id, blob, name);
  let audio = null;
  try { audio = await loadAudio(blob); }
  catch (e) { console.error(e); }
  p.duration = audio ? audio.duration : 0;
  await attach(p, blob, audio);
  store.save(p);
  $('loading').hidden = true;
  if (audio) {
    runAuto();
  } else {
    renderBars();
    toast(/^video\//.test(blob.type) || /\.(mov|mp4|m4v)$/i.test(name || '') ? 'Saved, but this phone could not read the sound from this video for the waveform and auto draft. You can still play it and tap along.' : 'Saved, but this phone could not decode it for the waveform and auto draft. You can still play it and tap along.', 6000);
  }
}

async function attach(p, blob, audio) {
  S.project = p; S.audio = audio; S.blob = blob;
  S.sel = S.selAnchor = S.selEnd = 0; S.undo = []; S.taps = []; S.loopOn = false; S.curBar = -1;
  $('btnUndo').disabled = true;
  if (blob) player.load(blob);
  syncSongFields();
  setLoop(false);
  renderBars(); renderPalettes(); updateTapInfo();
  $('autoResult').hidden = true;
  $('tapLatency').value = p.tapLatency ?? 40; $('tapLatencyOut').textContent = $('tapLatency').value + ' ms';
  resizeCanvases(); S.dirty = true;
}

async function openProject(id) {
  const p = await store.get(id);
  if (!p) { toast('That song could not be opened.'); return; }
  unlockAudio();
  show('editor');
  $('loading').hidden = false;
  try {
    const rec = await store.getAudio(id);
    let audio = null, blob = null;
    if (rec && rec.blob) { blob = rec.blob; audio = await loadAudio(blob); }
    await attach(p, blob, audio);
    if (!audio) toast('The audio for this song is not on this device. You can still edit the chart.', 4000);
  } catch (e) {
    console.error(e);
    await attach(p, null, null);
    toast('Could not load the audio. The chart is still editable.', 4000);
  } finally {
    $('loading').hidden = true;
  }
}

// ---------------------------------------------------------------- song fields
function fillSelect(sel, values, labels) {
  sel.innerHTML = '';
  values.forEach((v, i) => { const o = document.createElement('option'); o.value = v; o.textContent = labels ? labels[i] : v; sel.appendChild(o); });
}
function syncSongFields() {
  const p = P(); if (!p) return;
  $('songTitle').value = p.title; $('fTitle').value = p.title; $('fComposer').value = p.composer;
  $('fKey').value = p.key || ''; $('fTime').value = p.time; $('timeSig').value = p.time;
  const tempo = p.tempo ? String(Math.round(p.tempo * 10) / 10) : '';
  $('fTempo').value = p.tempo ? Math.round(p.tempo) : ''; $('bpmInput').value = tempo;
}

// ---------------------------------------------------------------- bars grid
let barEls = [];
function renderBars() {
  const host = $('bars');
  const p = P();
  host.innerHTML = '';
  barEls = [];
  if (!p || !p.bars.length) {
    if (S.analyzing) {
      host.innerHTML = `<div class="empty-bars"><div class="spinner" style="margin:0 auto 10px"></div><p><strong>Drafting the chart…</strong></p><p id="draftStatus">Listening to the recording</p></div>`;
    } else if (p && S.blob && !S.audio) {
      host.innerHTML = `<div class="empty-bars"><p><strong>No waveform for this recording.</strong></p><p>This phone couldn't decode it, so Auto draft can't run. Press play and use the <b>Tap</b> tab to set bar lines by ear.</p><p><button class="ghost small" type="button" id="btnSaveAudio">Save the recording to Files</button></p></div>`;
      $('btnSaveAudio').addEventListener('click', saveAudioFile);
    } else {
      host.innerHTML = `<div class="empty-bars"><p><strong>No bars yet.</strong></p><p>Open the <b>Tap</b> tab and tap along to set the bar lines, or use <b>Auto draft</b>.</p></div>`;
    }
    return;
  }
  const [lo, hi] = selRange();
  let carried = '';
  for (const r of sectionRanges(p)) {
    const sec = document.createElement('div'); sec.className = 'section';
    const head = document.createElement('button');
    head.type = 'button'; head.className = 'sec-head';
    head.textContent = r.label || 'Section';
    head.title = 'Rename, loop or remove this section';
    head.addEventListener('click', () => sectionMenu(r.bar));
    sec.appendChild(head);
    const grid = document.createElement('div'); grid.className = 'sec-grid';
    for (let i = r.bar; i < r.end; i++) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'bar'; b.dataset.i = i;
      const txt = normalizeBar(p.bars[i].chord);
      const num = `<span class="num">${i + 1}</span>`;
      if (txt) { b.innerHTML = num; b.appendChild(document.createTextNode(txt)); carried = lastChordOf(txt); }
      else { b.innerHTML = num + `<span class="carry"></span>`; b.querySelector('.carry').textContent = carried || '–'; }
      if (S.loopOn && i >= lo && i <= hi) b.classList.add('in-loop');
      if (i === S.sel) b.classList.add('sel');
      if (i === S.curBar) b.classList.add('now');
      bindBarPointer(b, i);
      barEls[i] = b;
      grid.appendChild(b);
    }
    sec.appendChild(grid); host.appendChild(sec);
  }
  updateSelLabel();
}

function bindBarPointer(el, i) {
  let timer = null, long = false;
  el.addEventListener('pointerdown', () => {
    long = false;
    timer = setTimeout(() => { long = true; selectBar(i, true); if (navigator.vibrate) navigator.vibrate(10); }, 450);
  });
  const cancel = () => clearTimeout(timer);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('click', (e) => { if (long) { long = false; return; } selectBar(i, e.shiftKey); });
}

function selectBar(i, extend, noSeek) {
  const p = P(); if (!p || !p.bars.length) return;
  commitTyping();
  i = Math.max(0, Math.min(i, p.bars.length - 1));
  if (extend) { S.selEnd = i; S.sel = i; }
  else { S.sel = S.selAnchor = S.selEnd = i; if (!noSeek && S.blob) { player.seek(p.bars[i].t); clicker.reset(); } }
  if (S.loopOn) setLoop(true);
  refreshBarClasses();
  updateSelLabel();
  S.builder = null;
  S.dirty = true;
}

function refreshBarClasses() {
  const [lo, hi] = selRange();
  barEls.forEach((el, i) => {
    if (!el) return;
    el.classList.toggle('sel', i === S.sel);
    el.classList.toggle('in-loop', S.loopOn && i >= lo && i <= hi);
    el.classList.toggle('now', i === S.curBar);
  });
}

function updateSelLabel() {
  const p = P(); if (!p) return;
  const [lo, hi] = selRange();
  $('selLabel').textContent = p.bars.length ? (lo !== hi ? `Bars ${lo + 1}–${hi + 1}` : `Bar ${S.sel + 1}`) : 'Bar –';
  if (document.activeElement !== $('chordInput') || S.typingBar < 0) {
    $('chordInput').value = p.bars[S.sel] ? normalizeBar(p.bars[S.sel].chord) : '';
    $('chordInput').placeholder = p.bars[S.sel] && !p.bars[S.sel].chord ? `${effectiveChordBefore(S.sel) || 'Chord'} (carries on)` : 'Chord, e.g. C#- or C G';
  }
}

// ---------------------------------------------------------------- chord entry
function targetBar() {
  const p = P();
  if (player.playing && $('followToggle').checked) {
    const i = barAt(player.time + 0.15 * player.rate);
    if (i >= 0) return i;
  }
  return S.sel;
}

function setBarChord(i, text, opts = {}) {
  const p = P(); if (!p.bars[i]) return;
  const t = normalizeBar(text);
  if (normalizeBar(p.bars[i].chord) === t) return;
  if (!opts.noUndo) pushUndo();
  p.bars[i].chord = t;
  changed();
}

function applyChord(name, opts = {}) {
  const p = P(); if (!p || !p.bars.length) { toast('Set the bar lines first (Tap tab or Auto draft).'); return; }
  const i = targetBar();
  const existing = normalizeBar(p.bars[i].chord);
  let text = name, part = 0;
  if (($('addMode').checked || opts.add) && existing && !/\s/.test(existing)) { text = existing + ' ' + name; part = 1; }
  setBarChord(i, text);
  S.builder = { bar: i, part };
  if (i !== S.sel && !player.playing) selectBar(i, false, true);
  flashBar(i);
}

function flashBar(i) {
  const el = barEls[i]; if (!el) return;
  el.animate?.([{ transform: 'scale(1.05)' }, { transform: 'scale(1)' }], { duration: 160 });
}

function commitTyping() {
  if (S.typingBar < 0) return;
  const i = S.typingBar; S.typingBar = -1;
  setBarChord(i, $('chordInput').value);
}

function nextBar() {
  commitTyping();
  const p = P(); if (!p.bars.length) return;
  selectBar(Math.min(S.sel + 1, p.bars.length - 1));
  $('chordInput').value = normalizeBar(p.bars[S.sel].chord);
}

function renderPalettes() {
  const p = P(); if (!p) return;
  // Chords used so far, in order of first appearance.
  const used = [];
  for (const b of p.bars) for (const c of normalizeBar(b.chord).split(/\s+/)) if (isChordToken(c) && !used.includes(c)) used.push(c);
  const host = $('usedChords'); host.innerHTML = '';
  if (!used.length) host.innerHTML = '<span class="none">Chords you enter show up here for quick tapping.</span>';
  used.slice(0, 24).forEach(c => host.appendChild(chordBtn(c)));
  const kc = $('keyChords'); kc.innerHTML = '';
  const key = p.key || 'C';
  $('keyChordsLabel').textContent = p.key ? `Key of ${p.key}` : 'Key of C (set the key in the Song tab)';
  diatonicChords(key).forEach(c => kc.appendChild(chordBtn(c)));
  const bc = $('borrowedChords'); bc.innerHTML = '';
  borrowedChords(key).forEach(c => bc.appendChild(chordBtn(c)));
  // Builder roots in key spelling.
  const sp = spellingFor(key);
  const rr = $('rootRow'); rr.innerHTML = '';
  const startPc = 0;
  for (let k = 0; k < 12; k++) {
    const pc = (startPc + k) % 12, name = sp[pc];
    const b = document.createElement('button'); b.type = 'button'; b.textContent = name;
    b.addEventListener('click', () => builderRoot(name));
    rr.appendChild(b);
  }
}
function chordBtn(c) {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = c;
  b.addEventListener('click', () => applyChord(c));
  return b;
}

function builderRoot(name) {
  const p = P();
  if ($('slashMode').checked && S.builder) {
    const { bar, part } = S.builder;
    const parts = normalizeBar(p.bars[bar].chord).split(/\s+/).filter(Boolean);
    if (parts[part]) {
      parts[part] = parts[part].replace(/\/.*$/, '') + '/' + name;
      setBarChord(bar, parts.join(' '));
      $('slashMode').checked = false;
      return;
    }
  }
  applyChord(name);
}
function builderQuality(q) {
  const p = P(); if (!S.builder || !p.bars[S.builder.bar]) { toast('Tap a root note first.'); return; }
  const { bar, part } = S.builder;
  const parts = normalizeBar(p.bars[bar].chord).split(/\s+/).filter(Boolean);
  let idx = part;
  if (!isChordToken(parts[idx])) idx = parts.findIndex(isChordToken);
  const c = parseChord(parts[idx] || '');
  if (!c) return;
  const part2 = idx;
  parts[part2] = c.rootName + q + (c.bassName ? '/' + c.bassName : '');
  setBarChord(bar, parts.join(' '));
}

// ---------------------------------------------------------------- sections
let secDialogBar = 0;
function sectionMenu(bar) {
  secDialogBar = bar;
  const p = P();
  const existing = p.sections.find(s => s.bar === bar);
  $('secBarLabel').textContent = 'bar ' + (bar + 1);
  $('secCustom').value = existing ? existing.label : '';
  $('secRemove').hidden = !existing;
  const ch = $('secChoices'); ch.innerHTML = '';
  const names = [...SECTION_NAMES];
  for (const s of p.sections) if (!names.includes(s.label)) names.push(s.label);
  names.forEach(n => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = n;
    b.addEventListener('click', () => { setSection(bar, n); $('sectionDialog').close(); });
    ch.appendChild(b);
  });
  const loopBtn = document.createElement('button'); loopBtn.type = 'button'; loopBtn.textContent = '⟲ Loop this section';
  loopBtn.addEventListener('click', () => {
    const r = sectionRanges(p).find(x => x.bar === bar);
    if (r) { S.selAnchor = r.bar; S.selEnd = S.sel = r.end - 1; setLoop(true); player.seek(p.bars[r.bar].t); }
    $('sectionDialog').close();
  });
  if (p.bars.length) ch.appendChild(loopBtn);
  $('sectionDialog').showModal();
}
function setSection(bar, label) {
  const p = P(); label = (label || '').trim(); if (!label) return;
  pushUndo();
  const ex = p.sections.find(s => s.bar === bar);
  if (ex) ex.label = label; else p.sections.push({ id: uid(), bar, label });
  p.sections.sort((a, b) => a.bar - b.bar);
  changed();
}
function removeSection(bar) {
  const p = P();
  pushUndo();
  p.sections = p.sections.filter(s => s.bar !== bar);
  changed();
}

// ---------------------------------------------------------------- bar editing
function remapSections(fn) {
  const p = P(); const seen = new Set();
  p.sections = p.sections.map(s => ({ ...s, bar: fn(s.bar) }))
    .filter(s => s.bar >= 0 && s.bar < p.bars.length && !seen.has(s.bar) && seen.add(s.bar))
    .sort((a, b) => a.bar - b.bar);
}
function splitBar() {
  const p = P(), i = S.sel; if (!p.bars[i]) return;
  pushUndo();
  const mid = (p.bars[i].t + barEnd(i)) / 2;
  const parts = normalizeBar(p.bars[i].chord).split(/\s+/).filter(Boolean);
  const first = parts.length >= 2 ? parts[0] : p.bars[i].chord;
  const second = parts.length >= 2 ? parts.slice(1).join(' ') : '';
  p.bars[i].chord = first;
  p.bars.splice(i + 1, 0, { t: mid, chord: second });
  remapSections(b => b > i ? b + 1 : b);
  changed();
}
function deleteBar() {
  const p = P(), i = S.sel; if (!p.bars[i] || p.bars.length < 2) return;
  pushUndo();
  p.bars.splice(i, 1);
  remapSections(b => b > i ? b - 1 : b);
  clampSel(); changed();
}
function snapBarToPlayhead() {
  const p = P(), i = S.sel, t = player.time; if (!p.bars[i]) return;
  if (i > 0 && t <= p.bars[i - 1].t + 0.05) { toast('The playhead is before the previous bar line.'); return; }
  pushUndo();
  const d = t - p.bars[i].t;
  for (let k = i; k < p.bars.length; k++) p.bars[k].t += d;
  while (p.bars.length > 1 && p.bars[p.bars.length - 1].t > duration() - 0.05) p.bars.pop();
  clampSel(); changed();
  toast(`Bar ${i + 1} and later moved ${d >= 0 ? '+' : ''}${Math.round(d * 1000)} ms`);
}
function shiftGrid(kind) {
  const p = P(); if (!p.bars.length) return;
  pushUndo();
  const n = bpb();
  const deltas = p.bars.map((b, i) => kind === 'beat' ? (barEnd(i) - b.t) / n : kind === '-beat' ? -(barEnd(i) - b.t) / n : Number(kind));
  p.bars.forEach((b, i) => { b.t += deltas[i]; });
  if (p.bars[0].t < 0) {
    if (p.bars[0].t > -0.25 * (barEnd(0) - p.bars[0].t)) p.bars[0].t = 0;
    else { p.bars.shift(); remapSections(b => b - 1); if (!p.sections.length || p.sections[0].bar !== 0) { /* implicit */ } }
  }
  while (p.bars.length > 1 && p.bars[p.bars.length - 1].t > duration() - 0.05) p.bars.pop();
  clampSel(); changed();
}
function halfTime() {
  const p = P(); if (p.bars.length < 2) return;
  pushUndo();
  const nb = [];
  for (let i = 0; i < p.bars.length; i += 2) {
    const a = normalizeBar(p.bars[i].chord), b = p.bars[i + 1] ? normalizeBar(p.bars[i + 1].chord) : '';
    const held = a || effectiveChordBefore(i);
    const c = b && b !== held ? `${held} ${b}`.trim() : a;
    nb.push({ t: p.bars[i].t, chord: c });
  }
  p.bars = nb;
  remapSections(b => Math.floor(b / 2));
  if (p.tempo) p.tempo /= 2;
  clampSel(); changed(); syncSongFields();
}
function doubleTime() {
  const p = P(); if (!p.bars.length) return;
  pushUndo();
  const nb = [];
  p.bars.forEach((bar, i) => {
    const mid = (bar.t + barEnd(i)) / 2;
    const parts = normalizeBar(bar.chord).split(/\s+/).filter(Boolean);
    nb.push({ t: bar.t, chord: parts.length >= 2 ? parts[0] : bar.chord });
    nb.push({ t: mid, chord: parts.length >= 2 ? parts.slice(1).join(' ') : '' });
  });
  p.bars = nb;
  remapSections(b => b * 2);
  if (p.tempo) p.tempo *= 2;
  clampSel(); changed(); syncSongFields();
}

/** Replace the bar lines, keeping chords and sections attached to the nearest new bar. */
function regrid(times) {
  const p = P();
  const old = p.bars, oldSecs = p.sections;
  const nb = times.map(t => ({ t, chord: '' }));
  const nearest = (t) => {
    let best = -1, bd = Infinity;
    nb.forEach((b, j) => { const d = Math.abs(b.t - t); if (d < bd) { bd = d; best = j; } });
    const len = nb.length > 1 ? (nb[Math.min(best + 1, nb.length - 1)].t - nb[Math.max(0, best - 1)].t) / 2 : 1;
    return bd < 0.5 * len ? best : -1;
  };
  old.forEach(b => { if (!b.chord) return; const j = nearest(b.t); if (j >= 0 && !nb[j].chord) nb[j].chord = b.chord; });
  const secs = [];
  oldSecs.forEach(s => { if (!old[s.bar]) return; const j = nearest(old[s.bar].t); if (j >= 0 && !secs.find(x => x.bar === j)) secs.push({ ...s, bar: j }); });
  p.bars = nb; p.sections = secs.sort((a, b) => a.bar - b.bar);
}

function steadyTimes(anchor, period, n) {
  const barDur = period * n, dur = duration();
  let t = anchor - Math.floor(anchor / barDur) * barDur;
  if (t < 0) t += barDur;
  const out = [];
  for (; t < dur - 0.5 * period; t += barDur) out.push(t);
  return out;
}

// ---------------------------------------------------------------- tapping
function tapLatency() { return Number($('tapLatency').value) / 1000; }
function onTap() {
  unlockAudio();
  if (!S.blob) { toast('Load audio first.'); return; }
  if (!player.playing) { toast('Press play first, then tap along.'); return; }
  const now = performance.now();
  if (now - S.lastTapAt > 2500 && S.taps.length) S.taps = [];
  S.lastTapAt = now;
  const t = player.time - tapLatency() * player.rate;
  S.taps.push(t);
  const pad = $('tapPad'); pad.classList.add('flash'); setTimeout(() => pad.classList.remove('flash'), 90);
  updateTapInfo();
  S.dirty = true;
}
function tapFit() {
  const taps = S.taps;
  const need = S.tapMode === 'beats' ? 4 : 2;
  if (taps.length < need) return null;
  const d = []; for (let i = 1; i < taps.length; i++) d.push(taps[i] - taps[i - 1]);
  const p0 = median(d);
  if (!(p0 > 0.15)) return null;
  const ks = taps.map(t => Math.round((t - taps[0]) / p0));
  const n = ks.length, mk = ks.reduce((a, b) => a + b, 0) / n, mt = taps.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  ks.forEach((k, i) => { num += (k - mk) * (taps[i] - mt); den += (k - mk) ** 2; });
  const period = den ? num / den : p0;
  return { anchor: mt - period * mk, period };
}
function updateTapInfo() {
  const n = S.taps.length, fit = tapFit();
  let txt = `${n} tap${n === 1 ? '' : 's'}`;
  if (fit) txt += ' · ' + (S.tapMode === 'beats' ? (60 / fit.period).toFixed(1) : (60 * bpb() / fit.period).toFixed(1)) + ' BPM';
  $('tapInfo').textContent = txt;
  $('btnApplyTaps').disabled = !fit;
}
function applyTaps() {
  const fit = tapFit(); if (!fit) return;
  pushUndo();
  const n = bpb();
  if (S.tapMode === 'beats') {
    regrid(steadyTimes(fit.anchor, fit.period, n));
    P().tempo = 60 / fit.period;
    toast(`Grid set: ${(60 / fit.period).toFixed(1)} BPM, bar lines from your first tap.`);
  } else {
    // Bar lines exactly where tapped; fill gaps from missed taps; extend at the song's ends.
    const taps = [...S.taps].sort((a, b) => a - b);
    const lens = []; for (let i = 1; i < taps.length; i++) lens.push(taps[i] - taps[i - 1]);
    const typical = median(lens);
    const lines = [taps[0]];
    for (let i = 1; i < taps.length; i++) {
      const gap = taps[i] - taps[i - 1], k = Math.round(gap / typical);
      for (let j = 1; j < k; j++) lines.push(taps[i - 1] + gap * j / k);
      lines.push(taps[i]);
    }
    const p = P();
    const before = p.bars.filter(b => b.t < taps[0] - 0.5 * typical).map(b => b.t);
    const head = before.length ? before : (() => { const h = []; for (let t = taps[0] - typical; t > -0.25 * typical; t -= typical) h.unshift(Math.max(0, t)); return h; })();
    const lastLen = median(lens.slice(-4));
    const after = p.bars.filter(b => b.t > taps[taps.length - 1] + 0.5 * lastLen).map(b => b.t);
    const tail = [];
    if (after.length) tail.push(...after);
    else for (let t = taps[taps.length - 1] + lastLen; t < duration() - 0.5 * lastLen / n; t += lastLen) tail.push(t);
    regrid([...head, ...lines, ...tail]);
    P().tempo = 60 * n / typical;
    toast(`${lines.length} bar lines set from your taps.`);
  }
  S.taps = []; updateTapInfo();
  clampSel(); changed(); syncSongFields();
}
function anchorHere() {
  const bpm = Number($('bpmInput').value);
  if (!(bpm >= 30 && bpm <= 320)) { toast('Enter a BPM first (or tap the beat).'); return; }
  if (!S.blob) return;
  pushUndo();
  regrid(steadyTimes(player.time, 60 / bpm, bpb()));
  P().tempo = bpm;
  S.sel = S.selAnchor = S.selEnd = Math.max(0, barAt(player.time + 0.01));
  changed(); syncSongFields();
  toast(`Steady grid at ${bpm} BPM with a bar line at ${fmtTime(player.time)}.`);
}

// ---------------------------------------------------------------- loop & transport
function setLoop(on) {
  S.loopOn = on && P() && P().bars.length > 0;
  $('btnLoop').setAttribute('aria-pressed', String(S.loopOn));
  const [lo, hi] = selRange();
  $('btnLoop').textContent = S.loopOn ? (lo === hi ? `Loop ${lo + 1}` : `Loop ${lo + 1}–${hi + 1}`) : 'Loop';
  refreshBarClasses(); S.dirty = true;
}
function loopBounds() {
  const [lo, hi] = selRange();
  return [P().bars[lo].t, barEnd(hi)];
}
function togglePlay() {
  unlockAudio();
  if (!S.blob) { toast('No audio loaded for this song.'); return; }
  if (player.playing) { player.pause(); }
  else {
    if (S.loopOn) { const [a, b] = loopBounds(); if (player.time < a - 0.05 || player.time >= b) player.seek(a); }
    clicker.reset(); player.play();
  }
}
function stepBar(dir) {
  const p = P(); if (!p.bars.length) { player.seek(player.time + dir * 2); return; }
  const cur = barAt(player.time);
  let i;
  if (dir < 0) i = cur < 0 ? 0 : (player.time - p.bars[cur].t > 0.4 ? cur : cur - 1);
  else i = cur + 1;
  i = Math.max(0, Math.min(i, p.bars.length - 1));
  selectBar(i);
}

// ---------------------------------------------------------------- auto draft
function runAuto(forceBpm) {
  if (S.analyzing) return;
  if (!S.audio) { toast(S.blob ? 'This phone could not decode this recording, so Auto draft cannot run. Tap along instead.' : 'Load audio first.', 4000); return; }
  const p = P();
  S.analyzing = true;
  $('btnAuto').disabled = true;
  const prog = $('autoProgress'); prog.hidden = false;
  const bar = prog.querySelector('i'), label = prog.querySelector('span');
  bar.style.width = '0%'; label.textContent = 'Starting…';
  if (!p.bars.length) renderBars();
  let worker;
  try { worker = new Worker('js/analysis-worker.js'); }
  catch (e) { finish(); toast('Auto draft is not available in this browser.'); return; }
  const opts = {
    beatsPerBar: bpb(), sevenths: $('optDetail').value === 'sevenths', slash: $('optSlash').checked,
    sections: $('optSections').checked, detectMeter: $('optMeter').value === 'detect', bpm: forceBpm || null,
  };
  const t0 = performance.now();
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      const base = m.stage.startsWith('Finding') ? 0 : 40, span = m.stage.startsWith('Finding') ? 40 : 60;
      bar.style.width = (base + span * m.frac).toFixed(0) + '%';
      label.textContent = m.stage + '…';
      const ds = $('draftStatus'); if (ds) ds.textContent = `${m.stage}… ${Math.round(base + span * m.frac)}%`;
    } else if (m.type === 'done') {
      worker.terminate(); finish();
      applyAuto(m.result, (performance.now() - t0) / 1000);
    } else if (m.type === 'error') {
      worker.terminate(); finish();
      toast('Auto draft failed: ' + m.message, 5000);
    }
  };
  worker.onerror = (e) => { worker.terminate(); finish(); toast('Auto draft failed: ' + (e.message || 'worker error'), 5000); };
  const samples = S.audio.mono.slice();
  worker.postMessage({ samples, opts }, [samples.buffer]);
  function finish() { S.analyzing = false; $('btnAuto').disabled = false; prog.hidden = true; if (!p.bars.length) renderBars(); }
}

function applyAuto(r, secs) {
  const p = P();
  if (!r.bars.length) { toast('No beat found in this recording.'); return; }
  pushUndo();
  const key = keyName(r.key.tonic, r.key.minor);
  p.key = key;
  p.tempo = r.bpm;
  if ($('optMeter').value === 'detect') p.time = r.beatsPerBar === 3 ? '3/4' : '4/4';
  let last = '';
  p.bars = r.bars.map(b => {
    const text = b.items.map(it => it.nc ? 'N.C.' : chordName(it.root, it.quality, it.bass, key)).join(' ');
    const out = (text === last) ? '' : text;
    if (text) last = text.split(' ').pop();
    return { t: b.start, chord: out };
  });
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  p.sections = (r.sections || []).map(s => ({ id: uid(), bar: s.bar, label: letters[s.group % 26] })).filter(s => s.bar < p.bars.length);
  S.sel = S.selAnchor = S.selEnd = 0;
  changed(); syncSongFields();
  const res = $('autoResult'); res.hidden = false;
  const tune = `<dt>Tuning</dt><dd>${r.tuningCents > 0 ? '+' : ''}${r.tuningCents} cents from A440</dd>`;
  res.innerHTML = `<dl>
      <dt>Tempo</dt><dd>${r.bpm.toFixed(1)} BPM</dd>
      <dt>Key</dt><dd>${key}</dd>
      <dt>Time</dt><dd>${p.time}</dd>
      <dt>Bars</dt><dd>${p.bars.length}${p.sections.length ? ` in ${p.sections.length} sections` : ''}</dd>${tune}
    </dl>
    <p class="muted hint">Took ${secs.toFixed(1)} s. Sections are lettered by repeating chord patterns: rename them by ear. If the bar lines feel twice too fast or slow, try:</p>
    <div class="row wrap"><button class="ghost small" type="button" data-rerun="0.5">Redo at ${(r.bpm / 2).toFixed(0)} BPM</button><button class="ghost small" type="button" data-rerun="2">Redo at ${(r.bpm * 2).toFixed(0)} BPM</button></div>`;
  res.querySelectorAll('[data-rerun]').forEach(b => b.addEventListener('click', () => runAuto(r.bpm * Number(b.dataset.rerun))));
  toast(`Draft ready: ${key}, ${Math.round(r.bpm)} BPM. Play it through and fix what's off.`, 4000);
}

/** Saves this song's audio (e.g. a recording) as a file. */
async function saveAudioFile() {
  const p = P(); if (!S.blob) { toast('No audio for this song.'); return; }
  const t = S.blob.type || '';
  const fromName = (p.audioName || '').match(/\.([a-z0-9]{2,5})$/i);
  const ext = fromName ? fromName[1] : t.includes('webm') ? 'webm' : t.includes('ogg') ? 'ogg' : t.includes('wav') ? 'wav' : t.includes('mpeg') ? 'mp3' : 'm4a';
  const name = (p.title || 'recording').replace(/[\\/:*?"<>|]+/g, '').trim() + '.' + ext;
  const file = new File([S.blob], name, { type: t || 'audio/mp4' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------------------------------------------------------------- export
let exportProjects = [];
function openExport(projects) {
  exportProjects = projects;
  const data = toBackup(projects);
  const nSec = data.songs.reduce((a, s) => a + s.sections.length, 0);
  const nBars = projects.reduce((a, p) => a + p.bars.length, 0);
  $('exportSummary').textContent = `${projects.length} song${projects.length > 1 ? 's' : ''} · ${nSec} section${nSec === 1 ? '' : 's'} · ${nBars} bars`;
  $('exportPreview').textContent = projects.length === 1
    ? data.songs[0].sections.map(s => `[${s.label}]\n${s.bars || '(empty)'}`).join('\n\n')
    : data.songs.map(s => `${s.title} — ${s.key || 'no key'}, ${s.sections.length} sections`).join('\n');
  const file = new File([JSON.stringify(data, null, 2)], backupFileName(projects), { type: 'application/json' });
  $('btnShare').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  $('exportDialog').showModal();
}
function exportFile() {
  const data = toBackup(exportProjects);
  return new File([JSON.stringify(data, null, 2)], backupFileName(exportProjects), { type: 'application/json' });
}
function downloadExport() {
  const f = exportFile();
  const url = URL.createObjectURL(f);
  const a = document.createElement('a');
  a.href = url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Saved ' + f.name);
}
async function shareExport() {
  try { await navigator.share({ files: [exportFile()], title: 'Chart Maker backup' }); }
  catch (e) { if (e.name !== 'AbortError') toast('Sharing failed. Use Save .json instead.'); }
}

// ---------------------------------------------------------------- recording
async function startRecording() {
  if (!Recorder.supported()) { toast('Recording is not supported in this browser.'); return; }
  unlockAudio();
  recorder = new Recorder();
  try {
    $('recTime').textContent = '0:00';
    $('recordDialog').showModal();
    await recorder.start((lvl, secs) => {
      $('recLevel').style.width = Math.min(100, lvl * 140) + '%';
      const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
      $('recTime').textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
    });
  } catch (e) {
    $('recordDialog').close();
    toast('Microphone not available: ' + (e.message || e.name), 4000);
    recorder = null;
  }
}
async function stopRecording() {
  if (!recorder) return;
  const blob = await recorder.stop();
  recorder = null;
  $('recordDialog').close();
  if (!blob || !blob.size) { toast('Nothing was recorded.'); return; }
  const d = new Date();
  const name = `Recording ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  openAudioBlob(blob, name);
}

// ---------------------------------------------------------------- waveforms
const ov = $('overview'), dt = $('detail');
let ovCache = null;
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function resizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  for (const c of [ov, dt]) {
    const w = Math.max(1, c.clientWidth), h = Math.max(1, c.clientHeight);
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  }
  ovCache = null; S.dirty = true;
}
function buildOverviewCache() {
  const w = ov.width, h = ov.height;
  const mk = (color) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (!S.audio) return c;
    const { min, max } = S.audio.peaks, n = min.length;
    g.fillStyle = color;
    for (let x = 0; x < w; x++) {
      const a = Math.floor(x / w * n), b = Math.max(a + 1, Math.floor((x + 1) / w * n));
      let lo = 0, hi = 0;
      for (let k = a; k < b && k < n; k++) { if (min[k] < lo) lo = min[k]; if (max[k] > hi) hi = max[k]; }
      const y0 = h / 2 - hi * h * 0.46, y1 = h / 2 - lo * h * 0.46;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
    return c;
  };
  ovCache = { base: mk(cssVar('--wave')), played: mk(cssVar('--wave-played')) };
}
function drawOverview() {
  const g = ov.getContext('2d'), w = ov.width, h = ov.height, dur = duration();
  g.clearRect(0, 0, w, h);
  if (!S.audio || !dur) return;
  if (!ovCache) buildOverviewCache();
  const x = player.time / dur * w;
  if (S.loopOn) { const [a, b] = loopBounds(); g.fillStyle = cssVar('--loop-soft'); g.fillRect(a / dur * w, 0, (b - a) / dur * w, h); }
  g.drawImage(ovCache.base, 0, 0);
  g.save(); g.beginPath(); g.rect(0, 0, x, h); g.clip(); g.drawImage(ovCache.played, 0, 0); g.restore();
  const p = P();
  if (p) {
    g.fillStyle = cssVar('--accent');
    for (const r of sectionRanges(p)) { if (!p.bars[r.bar]) continue; const sx = p.bars[r.bar].t / dur * w; g.fillRect(sx, 0, Math.max(1, devicePixelRatio), h); }
  }
  g.fillStyle = cssVar('--play'); g.fillRect(x - 1, 0, 2 * (window.devicePixelRatio || 1), h);
}
function detailSpan() { return Math.max(4, Math.min(10, dt.clientWidth / 110)); }
function drawDetail() {
  const g = dt.getContext('2d'), w = dt.width, h = dt.height, dpr = window.devicePixelRatio || 1;
  g.clearRect(0, 0, w, h);
  if (!S.audio) return;
  const span = detailSpan(), t = player.time, t0 = t - span / 3, pps = w / span;
  const X = (tt) => (tt - t0) * pps;
  const p = P();
  // Loop & selected bar shading.
  if (p && p.bars.length) {
    if (S.loopOn) { const [a, b] = loopBounds(); g.fillStyle = cssVar('--loop-soft'); g.fillRect(X(a), 0, (b - a) * pps, h); }
    else if (p.bars[S.sel]) { g.fillStyle = cssVar('--accent-soft'); g.fillRect(X(p.bars[S.sel].t), 0, (barEnd(S.sel) - p.bars[S.sel].t) * pps, h); }
  }
  // Waveform.
  const { min, max } = S.audio.peaks, n = min.length;
  g.fillStyle = cssVar('--wave');
  for (let x = 0; x < w; x++) {
    const ta = t0 + x / pps, tb = t0 + (x + 1) / pps;
    const a = Math.floor(ta * PEAK_RATE), b = Math.max(a + 1, Math.floor(tb * PEAK_RATE));
    if (b <= 0 || a >= n) continue;
    let lo = 0, hi = 0;
    for (let k = Math.max(0, a); k < b && k < n; k++) { if (min[k] < lo) lo = min[k]; if (max[k] > hi) hi = max[k]; }
    const top = 18 * dpr, mid = top + (h - top) / 2, amp = (h - top) * 0.46;
    g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
  }
  // Beats & bars.
  if (p && p.bars.length) {
    const n2 = bpb();
    g.font = `600 ${11 * dpr}px -apple-system, system-ui, sans-serif`;
    g.textBaseline = 'top';
    let carried = effectiveChordBefore(Math.max(0, barAt(t0)));
    for (let i = 0; i < p.bars.length; i++) {
      const s = p.bars[i].t, e = barEnd(i);
      const txt = normalizeBar(p.bars[i].chord);
      if (txt) carried = lastChordOf(txt);
      if (e < t0 || s > t0 + span) continue;
      g.fillStyle = cssVar('--beatline');
      for (let k = 1; k < n2; k++) g.fillRect(X(s + (e - s) * k / n2), 18 * dpr, dpr, h);
      g.fillStyle = cssVar('--barline');
      g.fillRect(X(s), 0, 2 * dpr, h);
      g.fillStyle = cssVar('--muted');
      g.fillText(String(i + 1), X(s) + 4 * dpr, 3 * dpr);
      g.fillStyle = cssVar('--text');
      g.font = `700 ${13 * dpr}px -apple-system, system-ui, sans-serif`;
      if (txt) g.fillText(txt, X(s) + 26 * dpr, 2 * dpr);
      g.font = `600 ${11 * dpr}px -apple-system, system-ui, sans-serif`;
    }
  }
  // Taps.
  g.fillStyle = cssVar('--accent');
  for (const tp of S.taps) { const x = X(tp); if (x >= 0 && x <= w) { g.beginPath(); g.moveTo(x - 5 * dpr, h); g.lineTo(x + 5 * dpr, h); g.lineTo(x, h - 9 * dpr); g.fill(); } }
  // Playhead.
  g.fillStyle = cssVar('--play'); g.fillRect(X(t) - dpr, 0, 2 * dpr, h);
}

function bindCanvasPointers() {
  const seekOv = (e) => { const r = ov.getBoundingClientRect(); const f = (e.clientX - r.left) / r.width; player.seek(Math.max(0, Math.min(1, f)) * duration()); clicker.reset(); S.dirty = true; };
  let ovDown = false;
  ov.addEventListener('pointerdown', (e) => { if (!S.audio) return; ovDown = true; ov.setPointerCapture(e.pointerId); seekOv(e); });
  ov.addEventListener('pointermove', (e) => { if (ovDown) seekOv(e); });
  ov.addEventListener('pointerup', () => { ovDown = false; });
  let drag = null;
  dt.addEventListener('pointerdown', (e) => { if (!S.audio) return; dt.setPointerCapture(e.pointerId); drag = { x: e.clientX, t: player.time, moved: false }; });
  dt.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 4) drag.moved = true;
    if (drag.moved) { const pps = dt.clientWidth / detailSpan(); player.seek(Math.max(0, drag.t - dx / pps)); S.dirty = true; }
  });
  dt.addEventListener('pointerup', (e) => {
    if (drag && !drag.moved) {
      const r = dt.getBoundingClientRect(), span = detailSpan();
      const tt = player.time - span / 3 + (e.clientX - r.left) / r.width * span;
      player.seek(Math.max(0, tt)); clicker.reset(); S.dirty = true;
    }
    drag = null;
  });
}

// ---------------------------------------------------------------- main loop
let lastTime = -1;
function frame() {
  requestAnimationFrame(frame);
  if ($('editor').hidden || !P()) return;
  const t = player.time;
  if (S.loopOn && player.playing && P().bars.length) {
    const [a, b] = loopBounds();
    if (t >= b - 0.01 || t < a - 0.75) { player.seek(a); clicker.reset(); }
  }
  const cur = barAt(t);
  if (cur !== S.curBar) {
    const prev = barEls[S.curBar]; if (prev) prev.classList.remove('now');
    S.curBar = cur;
    const el = barEls[cur];
    if (el) {
      el.classList.add('now');
      if (player.playing) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    if (player.playing && $('followToggle').checked && cur >= 0 && S.selAnchor === S.selEnd && !S.loopOn && S.typingBar < 0) {
      S.sel = S.selAnchor = S.selEnd = cur; refreshBarClasses(); updateSelLabel();
    }
  }
  const n = P().bars.length;
  $('barReadout').textContent = cur >= 0 ? `Bar ${cur + 1}/${n}` : (n ? 'Before bar 1' : 'No bars');
  $('timeReadout').textContent = fmtTime(t) + (player.rate !== 1 ? ` · ${Math.round(player.rate * 100)}%` : '');
  $('btnPlay').textContent = player.playing ? '❚❚' : '▶';
  $('btnPlay').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
  if (player.playing) clicker.tick(allBeatsCached(), t, player.rate);
  if (player.playing || S.dirty || t !== lastTime) { drawOverview(); drawDetail(); S.dirty = false; lastTime = t; }
}
let beatsCache = { key: '', beats: [] };
function allBeatsCached() {
  const p = P(); const k = p.bars.length + ':' + (p.bars[0]?.t || 0) + ':' + (p.bars.at(-1)?.t || 0) + ':' + p.time + ':' + S.undo.length;
  if (beatsCache.key !== k) beatsCache = { key: k, beats: allBeats() };
  return beatsCache.beats;
}

// ---------------------------------------------------------------- wiring
function bind() {
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) openAudioBlob(f, f.name);
  });
  $('btnRecord').addEventListener('click', startRecording);
  $('recStop').addEventListener('click', stopRecording);
  $('recordDialog').addEventListener('close', () => { if (recorder) { recorder.cancel(); recorder = null; } });
  $('btnExportAll').addEventListener('click', async () => {
    const all = await store.list();
    const checked = [...document.querySelectorAll('#libraryList input:checked')].map(i => i.dataset.id);
    const chosen = checked.length ? all.filter(p => checked.includes(p.id)) : all;
    if (chosen.length) openExport(chosen);
  });

  $('btnHome').addEventListener('click', () => { commitTyping(); store.save(P()); show('home'); });
  $('btnUndo').addEventListener('click', undo);
  $('btnExport').addEventListener('click', () => { commitTyping(); openExport([P()]); });
  $('btnExport2').addEventListener('click', () => { commitTyping(); openExport([P()]); });
  $('btnDownload').addEventListener('click', downloadExport);
  $('btnShare').addEventListener('click', shareExport);

  const setTitle = (v) => { P().title = v; $('songTitle').value = v; $('fTitle').value = v; save(); };
  $('songTitle').addEventListener('input', (e) => setTitle(e.target.value));
  $('fTitle').addEventListener('input', (e) => setTitle(e.target.value));
  $('fComposer').addEventListener('input', (e) => { P().composer = e.target.value; save(); });
  $('fKey').addEventListener('change', (e) => { pushUndo(); P().key = e.target.value; changed(); });
  const setTime = (v) => { pushUndo(); P().time = v; syncSongFields(); changed(); };
  $('fTime').addEventListener('change', (e) => setTime(e.target.value));
  $('timeSig').addEventListener('change', (e) => setTime(e.target.value));
  $('fTempo').addEventListener('change', (e) => { const v = Number(e.target.value); P().tempo = v > 0 ? v : null; syncSongFields(); save(); });
  $('bpmInput').addEventListener('change', (e) => { const v = Number(e.target.value); if (v > 0) { P().tempo = v; syncSongFields(); save(); } });
  $('btnRespell').addEventListener('click', () => {
    const p = P(); if (!p.key) { toast('Choose a key first.'); return; }
    pushUndo(); p.bars.forEach(b => { b.chord = respellBar(normalizeBar(b.chord), p.key); }); changed();
    toast(`Chord names spelled for ${p.key}.`);
  });
  $('btnSaveAudioSong').addEventListener('click', saveAudioFile);
  $('btnDeleteSong').addEventListener('click', async () => {
    if (!confirm(`Delete “${P().title || 'Untitled'}” and its audio from this device?`)) return;
    await store.remove(P().id); S.project = null; show('home');
  });

  // Transport
  $('btnPlay').addEventListener('click', togglePlay);
  $('btnPrevBar').addEventListener('click', () => stepBar(-1));
  $('btnNextBar').addEventListener('click', () => stepBar(1));
  $('speed').addEventListener('change', (e) => { player.setRate(Number(e.target.value)); clicker.reset(); });
  $('btnLoop').addEventListener('click', () => setLoop(!S.loopOn));
  $('btnClick').addEventListener('click', () => {
    unlockAudio(); clicker.enabled = !clicker.enabled; clicker.reset();
    $('btnClick').setAttribute('aria-pressed', String(clicker.enabled));
  });

  // Tabs
  document.querySelectorAll('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs [data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('.panel').forEach(pn => { pn.hidden = pn.dataset.panel !== b.dataset.tab; });
    if (b.dataset.tab === 'auto') $('autoWarn').hidden = !(P() && P().bars.length);
  }));

  // Chords
  const ci = $('chordInput');
  ci.addEventListener('input', () => { if (S.typingBar < 0) S.typingBar = S.sel; });
  ci.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (S.typingBar < 0) S.typingBar = S.sel; nextBar(); } });
  ci.addEventListener('change', commitTyping);
  $('btnSetNext').addEventListener('click', () => { if (S.typingBar < 0 && ci.value !== normalizeBar(P().bars[S.sel]?.chord)) S.typingBar = S.sel; nextBar(); });
  $('btnClearBar').addEventListener('click', () => { const [lo, hi] = selRange(); pushUndo(); for (let i = lo; i <= hi; i++) if (P().bars[i]) P().bars[i].chord = ''; changed(); });
  $('btnSection').addEventListener('click', () => { if (P().bars.length) sectionMenu(S.sel); });
  $('btnSplit').addEventListener('click', splitBar);
  $('btnDeleteBar').addEventListener('click', deleteBar);
  $('btnSnap').addEventListener('click', snapBarToPlayhead);
  $('btnNC').addEventListener('click', () => applyChord('N.C.'));
  $('btnPush').addEventListener('click', () => {
    const p = P(); if (!p.bars.length) return;
    const i = targetBar(), t = normalizeBar(p.bars[i].chord);
    if (!t) { toast('Enter the chord first, then mark it as a push.'); return; }
    setBarChord(i, t.startsWith('>') ? t.replace(/^>\s*/, '') : '> ' + t);
  });
  const qr = $('qualRow');
  QUALS.forEach(([q, lbl]) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = lbl; b.addEventListener('click', () => builderQuality(q)); qr.appendChild(b); });

  // Sections dialog
  $('secOk').addEventListener('click', (e) => { const v = $('secCustom').value.trim(); if (v) setSection(secDialogBar, v); else e.preventDefault(); });
  $('secRemove').addEventListener('click', () => { removeSection(secDialogBar); $('sectionDialog').close(); });

  // Tap
  const pad = $('tapPad');
  pad.addEventListener('pointerdown', (e) => { e.preventDefault(); onTap(); });
  document.querySelectorAll('[data-tapmode]').forEach(b => b.addEventListener('click', () => {
    S.tapMode = b.dataset.tapmode; S.taps = [];
    document.querySelectorAll('[data-tapmode]').forEach(x => x.setAttribute('aria-checked', String(x === b)));
    $('tapHelp').textContent = S.tapMode === 'beats'
      ? 'Press play, then tap on every beat, starting on a “1”. Keep going for a few bars.'
      : 'Press play, then tap once on each “1” (each bar line). Tap through the whole song if the tempo moves.';
    updateTapInfo();
  }));
  $('btnApplyTaps').addEventListener('click', applyTaps);
  $('btnResetTaps').addEventListener('click', () => { S.taps = []; updateTapInfo(); S.dirty = true; });
  $('btnAnchor').addEventListener('click', anchorHere);
  document.querySelectorAll('[data-shift]').forEach(b => b.addEventListener('click', () => shiftGrid(b.dataset.shift)));
  $('btnHalf').addEventListener('click', halfTime);
  $('btnDouble').addEventListener('click', doubleTime);
  $('tapLatency').addEventListener('input', (e) => { $('tapLatencyOut').textContent = e.target.value + ' ms'; if (P()) { P().tapLatency = Number(e.target.value); save(); } });

  // Auto
  $('btnAuto').addEventListener('click', () => runAuto());

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if ($('editor').hidden || document.querySelector('dialog[open]')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'select' || tag === 'textarea';
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); stepBar(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepBar(1); }
    else if (e.key.toLowerCase() === 't') { e.preventDefault(); onTap(); }
    else if (e.key.toLowerCase() === 'l') { setLoop(!S.loopOn); }
    else if (e.key === 'Enter') { e.preventDefault(); ci.focus(); }
  });

  window.addEventListener('resize', resizeCanvases);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { ovCache = null; S.dirty = true; });
  document.addEventListener('visibilitychange', () => { if (document.hidden && P()) store.save(P()); });
  bindCanvasPointers();
}

function init() {
  fillSelect($('fKey'), ['', ...MAJOR_KEYS, ...MINOR_KEYS], ['—', ...MAJOR_KEYS, ...MINOR_KEYS]);
  fillSelect($('fTime'), TIME_SIGS); fillSelect($('timeSig'), TIME_SIGS);
  bind();
  show('home');
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Hook for automated tests.
  window.__charter = { S, player, applyChord, selectBar, toBackup: () => toBackup([P()]) };
}
init();
