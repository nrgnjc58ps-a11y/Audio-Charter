// Builds the Chart Maker backup file ("Restore backup" format).

import { normalizeBar, lastChordOf } from './chords.js';

export function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** Sections with their bar index ranges. Always starts at bar 0. */
export function sectionRanges(project) {
  const secs = (project.sections || []).filter(s => s.bar >= 0 && s.bar < project.bars.length).sort((a, b) => a.bar - b.bar);
  if (!secs.length || secs[0].bar !== 0) secs.unshift({ id: 'implicit', bar: 0, label: secs.length ? 'Intro' : 'A' });
  return secs.map((s, i) => ({ ...s, end: i + 1 < secs.length ? secs[i + 1].bar : project.bars.length }));
}

/**
 * The bars text for a run of bars, in chart style:
 * a chord is written where it changes; an empty bar means the chord carries on.
 * The first bar of a section always names its chord.
 */
export function barsText(texts, carried) {
  let last = carried || '';
  return texts.map((raw, i) => {
    const t = normalizeBar(raw);
    if (!t) {
      if (i === 0 && last) return last;
      return '';
    }
    const single = !/\s/.test(t);
    const out = single && t === last && i > 0 ? '' : t;
    last = lastChordOf(t);
    return out;
  }).join(' | ').replace(/\s+/g, ' ').trim();
}

export function toChartMakerSong(project) {
  const ranges = sectionRanges(project);
  let carried = '';
  const sections = ranges.map((r) => {
    const texts = project.bars.slice(r.bar, r.end).map(b => b.chord || '');
    const bars = barsText(texts, carried);
    for (const t of texts) { const c = lastChordOf(normalizeBar(t)); if (c) carried = c; }
    return {
      id: r.id && r.id !== 'implicit' ? r.id : uid(),
      label: r.label || '',
      bars,
      rhythm: 'slashes',
      perLine: 4,
      repeat: false,
      times: '',
      ending1: '',
      ending2: '',
      note: '',
      pageBreak: false,
    };
  });
  return {
    id: project.chartId || project.id,
    title: project.title || '',
    composer: project.composer || '',
    tempo: project.tempo ? String(Math.round(project.tempo)) : '',
    time: project.time || '4/4',
    key: project.key || '',
    transpose: 0,
    style: 'hand',
    useRaw: false,
    raw: '',
    updated: Date.now(),
    sections,
  };
}

export function toBackup(projects) {
  return { app: 'chart-maker', songs: projects.map(toChartMakerSong) };
}

export function backupFileName(projects) {
  const base = projects.length === 1 ? (projects[0].title || 'chart') : 'audio-charter-songs';
  return base.replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 60) + '.json';
}
