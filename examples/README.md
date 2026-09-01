# Example music

Ready-made music you can stream into GarageBand — from a one-finger melody to full multi-layer arrangements with builds, drops, risers, and tempo ramps. They double as format documentation for any agent generating music.

Every example has an MP3 preview in [`audio/`](audio/) (synthesized straight from the JSON with `scripts/render-previews.mjs`, so what you hear is exactly what the MIDI plays — GarageBand's instruments will sound far better).

## Full arrangements (multi-layer)

| File | Listen | What's inside |
|---|---|---|
| [`edm-anthem.json`](edm-anthem.json) | [▶ mp3](audio/edm-anthem.mp3) | **"Neon Skyline"** — 5 layers (drums, bass, chords, lead, FX). Intro pads → build with accelerating snare roll + riser → drop with bass groove, chord stabs and a lead hook → fall + ritardando outro (128→92 BPM) |
| [`cinematic-swell.json`](cinematic-swell.json) | [▶ mp3](audio/cinematic-swell.mp3) | **"Dawn Over Ice"** — 4 layers (low/mid/high strings, percussion). Swelling bows → rising theme with accelerando (70→84 BPM) → timpani roll into the climax → falling resolution with ritardando |

## Single sequences

| File | Listen | What it is | Suggested patch |
|---|---|---|---|
| [`twinkle.json`](twinkle.json) | [▶ mp3](audio/twinkle.mp3) | Simple melody, the "hello world" test | any keyboard |
| [`lofi-chords.json`](lofi-chords.json) | [▶ mp3](audio/lofi-chords.mp3) | Fmaj7–Em7–Dm7–Cmaj7 at 72 BPM | electric piano |
| [`funk-bassline.json`](funk-bassline.json) | [▶ mp3](audio/funk-bassline.mp3) | Syncopated C-minor groove | fingerstyle bass |
| [`drum-groove.json`](drum-groove.json) | [▶ mp3](audio/drum-groove.mp3) | Two-bar boom-bap beat | **Drum Kit** track |

## Try one without an MCP client

Build first (`npm install && npm run build`), open GarageBand with a software-instrument track selected, then:

```bash
node examples/play.mjs examples/edm-anthem.json
```

- Multi-layer songs play as a full mix on the selected instrument (GarageBand routes live MIDI to one track).
- `--layer bass` plays just that layer; `--record --layer drums` records it into the project.
- **To build the real arrangement**: record one layer, add a new software-instrument track in GarageBand (pick the right instrument), record the next layer, and so on. An MCP agent does this with `gb_record_sequence` + `gb_add_software_instrument_track`.

## Format

A **sequence** is `tempo` + `events` on a beat grid — what `gb_play_sequence` / `gb_record_sequence` take. A **song** adds `layers` and an optional `tempoMap` — what `gb_play_song` takes.

```json
{
  "tempo": 128,
  "tempoMap": [
    { "beat": 32, "bpm": 128 },
    { "beat": 40, "bpm": 92, "ramp": true }
  ],
  "layers": [
    {
      "name": "drums",
      "channel": 10,
      "events": [
        { "note": "kick", "startBeat": 0, "durationBeats": 0.5, "velocity": 110 },
        { "note": "openhat", "startBeat": 0.5, "durationBeats": 0.4 }
      ]
    },
    {
      "name": "chords",
      "channel": 3,
      "events": [
        { "notes": ["A2", "C3", "E3", "G3"], "startBeat": 0, "durationBeats": 4, "velocity": 70 }
      ]
    }
  ]
}
```

- `note` — a name (`"C4"`, `"F#3"`, `"Bb2"`), a drum alias (`kick`, `snare`, `hihat`, `openhat`, `clap`, `crash`, `ride`, `tomlow`, …), or a raw MIDI number 0–127
- `notes` — several notes at once (a chord)
- `startBeat` / `durationBeats` — position and length in beats; fractions welcome (`0.25` = sixteenth at 4/4)
- `velocity` — 1–127, default 100; ramp it across notes for crescendos, builds, and risers
- `tempoMap` — tempo changes at beats; `"ramp": true` glides linearly from the previous tempo, arriving at that beat (accelerando/ritardando). To ramp only near the end, pin the old tempo first, as above
- `layers` — named parts, each with a default MIDI `channel`

Musical devices used in the arrangements, all expressible with plain notes:

- **Riser** — ascending 16th-note scale run with velocity ramping up (see `fx` layer of the EDM anthem, beats 8–16)
- **Fall** — the same descending with velocity ramping down (beats 32+)
- **Build** — snare roll subdividing from 8ths to 16ths with rising velocity
- **Drop** — everything lands together on a downbeat after the build, with a crash
- **Swell** — repeated string bows with stepwise rising velocity (cinematic piece, beats 0–16)
