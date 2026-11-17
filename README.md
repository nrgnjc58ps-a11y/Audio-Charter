# Audio Charter

Drafts guitar chord charts from a recording, for **Chart Maker**. Works on iPhone, iPad and desktop browsers. It is plain HTML/CSS/JS with no build step, and can be installed to the home screen (PWA, works offline once loaded).

## Using it

1. **Open audio file** (MP3, M4A, WAV…) or **Record** with the microphone.
2. Set the bar lines, either way:
   - **Tap tab:** press play and tap every beat starting on a "1" (or tap only the bar lines if the tempo drifts), then **Use these taps**. Or type a BPM and press **Bar line here** on a downbeat. Nudge the grid by 10 ms or one beat, or switch to half/double time.
   - **Auto draft tab:** detects tempo, beats, downbeats, key and chords, then fills in a draft.
3. **Chords tab:** with *Follow playback* on, tap a chord button as its bar plays, or select a bar and type (`C#-`, `C G`, `B/A`; `m`, `maj7` and `m7b5` are converted to `-`, `Δ7` and `ø7` for you) then press Enter to go to the next bar. Leave a bar empty and the chord carries on. **Section…** marks Intro/Verse/Chorus and so on.
4. **Loop:** select bars (shift-click, or long-press a second bar) and press **Loop**. You can also loop a section from its label. The speed menu slows playback without changing the pitch. **Click** plays a metronome on the grid so you can check it.
5. **Export** saves a `.json` file. In Chart Maker, use **Restore backup** and pick that file. You can export several songs from the home screen at once.

Songs and their audio are saved on the device, in the browser's IndexedDB storage.

### Keyboard (iPad keyboard or desktop)
Space plays and pauses. ← and → move by one bar. `T` taps. `L` turns the loop on and off. Enter jumps to the chord box. ⌘Z undoes.

## Export format

```json
{ "app": "chart-maker", "songs": [{ "id": "…", "title": "", "composer": "", "tempo": "120", "time": "4/4", "key": "E",
  "transpose": 0, "style": "hand", "useRaw": false, "raw": "", "updated": 1700000000000,
  "sections": [{ "id": "…", "label": "Verse", "bars": "E | | C#- | | A | B/A", "rhythm": "slashes", "perLine": 4,
    "repeat": false, "times": "", "ending1": "", "ending2": "", "note": "", "pageBreak": false }] }] }
```

A chord is written where it changes and an empty bar carries the chord on. The first bar of each section always names its chord. Chords use Chart Maker's spelling: minor `-`, `Δ7`, `ø7`, `°7`, `°`, `+`. Push (`> D`) and `N.C.` pass through. The song's key is still written like `E`, `C#m` or `Bb`. Chord names are spelled for the song's key (for example Bb in flat keys). **Song → Respell chords for this key** fixes spellings after you change the key. Each song keeps the same `id` across exports.

## Auto draft: how it works and what to expect

`js/dsp.js` is a self-contained analysis engine. It runs in a Web Worker and needs no network or library downloads, so it works offline:

- **Tempo and beats:** spectral-flux onsets, then autocorrelation tempo weighted toward kick/bass, then dynamic-programming beat tracking.
- **Chords:** a beat-synchronous chroma (with tuning correction), harmonic chord templates (major/minor, optionally 7ths), and a Viterbi smoother that makes chord changes cheaper on bar lines.
- **Downbeats:** chosen from where harmony changes and the low-frequency hits land.
- **Key:** Krumhansl profiles combined with which chords appear. Slash chords come from a separate bass chroma.

It is a **draft**. On clear pop/rock recordings expect most chords right. Busy mixes, distorted guitars, jazz voicings and rubato will need more fixing. Section letters (A, B, C…) only group repeating chord patterns, so rename them by ear. If the bar lines come out twice too fast or slow, use the "Redo at … BPM" buttons.

## Development

```sh
python3 -m http.server 8000         # then open http://localhost:8000
node tests/dsp.test.js              # engine against synthetic songs with known answers
node tests/export.test.mjs          # Chart Maker format
node tests/synth.js sample.wav      # make a test recording
```

Bump `CACHE` in `sw.js` when you change app files, so installed copies update.
