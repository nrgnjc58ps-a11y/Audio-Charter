// Chord and key spelling for guitar charts. Letter names only, no Nashville numbers.

const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
// Neutral spelling for C major / A minor (common in pop/rock charts).
const NEUTRAL = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const ALLOWED = new Set([...SHARPS, ...FLATS]);

export const MAJOR_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export const MINOR_KEYS = ['Cm', 'C#m', 'Dm', 'D#m', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];
const DETECTED_MAJOR = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const DETECTED_MINOR = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];

export function notePc(name) {
  const m = /^([A-G])([#b]?)$/.exec(name);
  if (!m) return -1;
  return (LETTER_PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? 11 : 0)) % 12;
}

/** "C#m" -> { tonic: 1, minor: true, letter: 'C', acc: '#' } */
export function parseKey(str) {
  const m = /^\s*([A-Ga-g])([#b♯♭]?)\s*(m|min|minor)?\s*$/i.exec(str || '');
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const acc = m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : m[2];
  return { tonic: notePc(letter + acc), minor: !!m[3], letter, acc };
}

export function keyName(tonic, minor) {
  return minor ? DETECTED_MINOR[tonic] : DETECTED_MAJOR[tonic];
}

// Degrees from the tonic for each semitone, as [scale step 0-6, label].
const MAJOR_DEG = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6];   // 1 b2 2 b3 3 4 #4 5 b6 6 b7 7
const MINOR_DEG = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6];   // 1 b2 2 b3 3 4 b5 5 b6 6 b7 7
const MAJOR_SIG_SHARP = new Set([7, 2, 9, 4, 11, 6, 1]);   // G D A E B F# C#
const accidentalTypeFor = (k) => {
  // 'sharp' | 'flat' | 'neutral' — by the key signature of the relative major.
  const maj = k.minor ? (k.tonic + 3) % 12 : k.tonic;
  if (maj === 0) return 'neutral';
  if (k.acc === 'b') return 'flat';
  if (k.acc === '#') return 'sharp';
  return MAJOR_SIG_SHARP.has(maj) ? 'sharp' : 'flat';
};

/** Array of 12 note names for chord roots in this key (index = pitch class). */
export function spellingFor(key) {
  const k = typeof key === 'string' ? parseKey(key) : key;
  if (!k) return NEUTRAL.slice();
  const type = accidentalTypeFor(k);
  const fallback = type === 'sharp' ? SHARPS : type === 'flat' ? FLATS : NEUTRAL;
  const tonicLetter = LETTERS.indexOf(k.letter || (type === 'flat' ? FLATS : SHARPS)[k.tonic][0]);
  const degs = k.minor ? MINOR_DEG : MAJOR_DEG;
  const out = new Array(12);
  for (let st = 0; st < 12; st++) {
    const pc = (k.tonic + st) % 12;
    const letter = LETTERS[(tonicLetter + degs[st]) % 7];
    let diff = (pc - LETTER_PC[letter] + 12) % 12;
    const acc = diff === 0 ? '' : diff === 1 ? '#' : diff === 11 ? 'b' : null;
    const name = acc === null ? null : letter + acc;
    out[pc] = name && ALLOWED.has(name) && !(type === 'neutral' && name === 'A#') ? name : fallback[pc];
  }
  return out;
}

const ROOT_RE = /^([A-Ga-g])([#b♯♭]?)/;

function normAcc(a) { return a === '♯' ? '#' : a === '♭' ? 'b' : a; }

/** Tidies one chord symbol as typed: "c#min7" -> "C#m7", "bb/d" -> "Bb/D". */
export function normalizeChord(token) {
  let t = (token || '').trim().replace(/\|/g, '');
  if (!t) return '';
  const m = ROOT_RE.exec(t);
  if (!m) return t; // N.C., x, etc. — keep as typed
  let root = m[1].toUpperCase() + normAcc(m[2]);
  let rest = t.slice(m[0].length);
  let bass = '';
  const slash = rest.lastIndexOf('/');
  if (slash >= 0) {
    const bm = /^([A-Ga-g])([#b♯♭]?)$/.exec(rest.slice(slash + 1));
    if (bm) { bass = '/' + bm[1].toUpperCase() + normAcc(bm[2]); rest = rest.slice(0, slash); }
  }
  rest = chartMakerQuality(rest);
  return root + rest + bass;
}

/**
 * Chord quality in Chart Maker's spelling: minor "-", major 7th "Δ7",
 * half-diminished "ø7", diminished "°" / "°7", augmented "+".
 * Accepts the usual alternatives (m, min, maj7, M7, m7b5, dim, aug…).
 */
export function chartMakerQuality(rest) {
  return (rest || '')
    .replace(/^(m7b5|min7b5|mi7b5|-7b5|ø7?)/, 'ø7')
    .replace(/^(dim7|°7|o7)/, '°7')
    .replace(/^(dim|°)/, '°')
    .replace(/^(aug|\+)/, '+')
    .replace(/^(maj|Maj|MAJ|ma|M|Δ)(?=\d)/, 'Δ')
    .replace(/^(maj|Maj|MAJ)$/, '')
    .replace(/^(min|mi|m|-)(?!aj)/, '-');
}

/** Normalizes the text for one bar (chords separated by spaces). "%", "-" or "/" alone mean "same". */
export function normalizeBar(text) {
  const parts = (text || '').replace(/\|/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1 && /^(%|-|\/)$/.test(parts[0])) return '';
  return parts.map(t => /^n\.?c\.?$/i.test(t) ? 'N.C.' : normalizeChord(t)).join(' ');
}

/** { root pc, rootName, rest, bass pc, bassName } or null for non-chords. */
export function parseChord(sym) {
  const m = /^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/.exec(sym || '');
  if (!m) return null;
  return { root: notePc(m[1]), rootName: m[1], rest: m[2], bass: m[3] ? notePc(m[3]) : -1, bassName: m[3] || '' };
}

export function respellChord(sym, key) {
  const p = parseChord(sym);
  if (!p || p.root < 0) return sym;
  const sp = spellingFor(key);
  return sp[p.root] + p.rest + (p.bass >= 0 ? '/' + sp[p.bass] : '');
}

export function respellBar(text, key) {
  return (text || '').split(/\s+/).filter(Boolean).map(c => respellChord(c, key)).join(' ');
}

/** Chord name from analysis output. */
export function chordName(root, quality, bass, key) {
  const sp = spellingFor(key);
  return sp[root] + chartMakerQuality(quality || '') + (bass >= 0 && bass !== root ? '/' + sp[bass] : '');
}

/** The common chords in a key, for the quick palette. */
export function diatonicChords(key) {
  const k = parseKey(key);
  if (!k) return [];
  const sp = spellingFor(k);
  const at = (st, q) => sp[(k.tonic + st) % 12] + chartMakerQuality(q);
  return k.minor
    ? [at(0, 'm'), at(3, ''), at(5, 'm'), at(7, 'm'), at(7, ''), at(8, ''), at(10, '')]
    : [at(0, ''), at(2, 'm'), at(4, 'm'), at(5, ''), at(7, ''), at(9, 'm'), at(10, '')];
}

/** True for a chord symbol or N.C. (not markings like ">" push or "." hold). */
export function isChordToken(tok) {
  return /^[A-G]/.test(tok || '') || /^N\.?C\.?$/i.test(tok || '');
}

/** Last chord symbol written in a bar's text (markings skipped), or '' */
export function lastChordOf(text) {
  const parts = (text || '').trim().split(/\s+/).filter(isChordToken);
  return parts.length ? parts[parts.length - 1] : '';
}

/** Chords borrowed from the parallel key, common in rock and pop. */
export function borrowedChords(key) {
  const k = parseKey(key);
  if (!k) return [];
  const sp = spellingFor(k);
  const at = (st, q) => sp[(k.tonic + st) % 12] + chartMakerQuality(q);
  return k.minor
    ? [at(0, ''), at(5, ''), at(1, ''), at(2, ''), at(9, 'm')]
    : [at(10, ''), at(8, ''), at(3, ''), at(2, ''), at(4, ''), at(5, 'm')];
}
