// Checks the Chart Maker export format. Usage: node tests/export.test.mjs
import assert from 'node:assert/strict';
import { toBackup, barsText } from '../js/export.js';

// The example from the brief: "E | | C#m | | A | B/A"
assert.equal(barsText(['E', '', 'C#m', '', 'A', 'B/A']), 'E | | C#m | | A | B/A');
// Repeating the same chord is written as an empty (carry-on) bar.
assert.equal(barsText(['E', 'E', 'c#m', 'C#m']), 'E | | C#m |');
// Two chords in a bar, flats kept, first bar of a section names the carried chord.
assert.equal(barsText(['', 'Eb F', 'F', 'Bb'], 'Bb'), 'Bb | Eb F | | Bb');
assert.equal(barsText(['Am', '%', '-']), 'Am | |');

const project = {
  id: 'p1', chartId: 'song-1', title: 'Test', composer: 'Me', key: 'E', time: '4/4', tempo: 119.6,
  bars: ['E', '', 'C#m', '', 'A', 'B/A', 'E', ''].map((chord, i) => ({ t: i * 2, chord })),
  sections: [{ id: 's1', bar: 0, label: 'Verse' }, { id: 's2', bar: 4, label: 'Chorus' }],
};
const out = toBackup([project]);
assert.equal(out.app, 'chart-maker');
const s = out.songs[0];
assert.deepEqual(Object.keys(s), ['id', 'title', 'composer', 'tempo', 'time', 'key', 'transpose', 'style', 'useRaw', 'raw', 'updated', 'sections']);
assert.equal(s.id, 'song-1'); assert.equal(s.tempo, '120'); assert.equal(s.key, 'E');
assert.equal(s.transpose, 0); assert.equal(s.style, 'hand'); assert.equal(s.useRaw, false); assert.equal(s.raw, '');
assert.equal(typeof s.updated, 'number');
assert.deepEqual(Object.keys(s.sections[0]), ['id', 'label', 'bars', 'rhythm', 'perLine', 'repeat', 'times', 'ending1', 'ending2', 'note', 'pageBreak']);
assert.equal(s.sections[0].bars, 'E | | C#m |');
assert.equal(s.sections[1].bars, 'A | B/A | E |');
assert.equal(s.sections[1].label, 'Chorus');
// No sections at all: one section holding every bar.
const solo = toBackup([{ ...project, sections: [] }]).songs[0];
assert.equal(solo.sections.length, 1);
assert.equal(solo.sections[0].bars, 'E | | C#m | | A | B/A | E |');
console.log('export tests passed');

// Chart Maker markings: push and N.C. pass through; a marking never counts as a chord.
assert.equal(barsText(['C', '> D', '', 'n.c.', 'D']), 'C | > D | | N.C. | D');
assert.equal(barsText(['D .', 'D', 'E-7']), 'D . | | Em7');
console.log('marking tests passed');
