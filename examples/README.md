# Example sequences

Ready-made music you can stream into GarageBand — useful for testing the server and as a reference for the sequence format any agent can generate.

| File | What it is | Suggested patch |
|---|---|---|
| [`twinkle.json`](twinkle.json) | Simple melody, the "hello world" test | any keyboard |
| [`lofi-chords.json`](lofi-chords.json) | Fmaj7–Em7–Dm7–Cmaj7 at 72 BPM | electric piano |
| [`funk-bassline.json`](funk-bassline.json) | Syncopated C-minor groove | fingerstyle bass |
| [`drum-groove.json`](drum-groove.json) | Two-bar boom-bap beat | **Drum Kit** track |

## Try one without an MCP client

Build first (`npm install && npm run build`), open GarageBand with a software-instrument track selected, then:

```bash
node examples/play.mjs examples/lofi-chords.json
```

Add `--record` to record it into the project instead of just auditioning it.

## Sequence format

Sequences are what you pass to the `gb_play_sequence` / `gb_record_sequence` tools: a `tempo` (BPM) and `events` on a beat grid.

```json
{
  "tempo": 90,
  "events": [
    { "note": "C4", "startBeat": 0, "durationBeats": 1, "velocity": 100 },
    { "notes": ["C3", "E3", "G3"], "startBeat": 1, "durationBeats": 2 },
    { "note": "kick", "startBeat": 3, "durationBeats": 0.5 }
  ]
}
```

- `note` — a name (`"C4"`, `"F#3"`, `"Bb2"`), a drum alias (`kick`, `snare`, `hihat`, `openhat`, `clap`, `crash`, `ride`, …), or a raw MIDI number 0–127
- `notes` — several notes at once (a chord)
- `startBeat` / `durationBeats` — position and length on the beat grid; fractions welcome (`0.5` = eighth note at 4/4)
- `velocity` — 1–127, default 100
