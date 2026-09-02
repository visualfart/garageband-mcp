# Agent Playbook

You are driving a real instance of GarageBand on someone's Mac through 46 tools. This document is how to do it *well* — read it once before your first session. It covers the mental model, the golden-path workflows, musical craft, and error recovery.

## 1. Mental model: three control planes

GarageBand has no API. This server reaches it three ways, and knowing which plane a tool uses tells you what can go wrong:

| Plane | Tools | Reliability | Failure mode |
|---|---|---|---|
| **Virtual MIDI** | `gb_play_*`, `gb_record_sequence` (the notes), `gb_send_cc`, `gb_pitch_bend` | Excellent — real CoreMIDI, ~5ms jitter | Notes go to whichever track is *selected and record-armed*; if nothing sounds, the wrong track is selected |
| **Accessibility values** | tempo, playhead, track/master volume, pan, Smart Controls | Very good — read *and* write, verified by read-back | Element not found (pane closed, LCD in wrong mode, localized UI) |
| **Keystrokes / clicks / menus** | transport, tracks, Library, Loops, dialogs, export | Good but stateful | Keyboard focus in the wrong place; modal dialogs blocking everything |

Three facts to internalize:

1. **All live MIDI goes to the ONE selected track.** MIDI channels are labels for your own organization, not routing. A five-layer song played via `gb_play_song` sounds on a single instrument. Multi-instrument music is built by *recording layer by layer*.
2. **The project chooser and modal dialogs freeze GarageBand's Apple Event queue.** The server detects and routes around the chooser, but if a tool times out, your first move is `gb_ui_state` — something modal is probably open.
3. **Keyboard focus is state you must respect.** Library and Loops interactions move focus away from the Tracks area. The server cleans up after itself (`gb_set_track_instrument` restores focus; `gb_select_track {index}` clicks headers so focus doesn't matter), but prefer index-based selection over arrow keys always.

## 2. Session start ritual

```
gb_check_permissions   → fix anything it reports before proceeding
gb_launch              → tells you if the project chooser is up
gb_new_project | gb_open_project
gb_ui_state            → confirm: project open, no sheets, GarageBand frontmost
```

Never assume state. If anything surprises you mid-session, `gb_ui_state` (cheap, text) then `gb_screenshot` (visual confirmation).

## 3. The golden path: produce a multi-instrument song

This is the flow that produces real, multi-instrument music in a project. Follow the order exactly — instrument *before* recording, always.

```
1. gb_new_project
2. gb_set_tempo {bpm: 90}                        ← project tempo = your composition tempo
3. gb_toggle_metronome, gb_toggle_count_in       ← count-in on = tight alignment
4. For EACH layer (drums first, then bass, then harmony, then melody):
   a. gb_add_software_instrument_track           (skip for layer 1 — new projects have one)
   b. gb_set_track_instrument {instrument: "Drum Kit", trackIndex: N}
   c. gb_play_note {note: "C3"}                  ← cheap audition: is the sound right?
   d. gb_record_sequence {tempo: 90, events: [...], countInBars: 1}
   e. gb_play → listen (or gb_screenshot: is there a green region at bar 1?)  → gb_stop
5. gb_set_track_volume / gb_set_track_pan per track (see §6 Mixing)
6. gb_save_project {name: "..."}
7. gb_export_song {filename: "...", format: "mp3"}
```

Why drums first: every later layer is recorded against the earlier ones, and hearing the groove while strings go down keeps the arrangement honest.

**Recording invariants** (the server enforces the first two, you own the rest):
- The playhead is verified at bar 1 before every take (or the tool refuses — never work around this with extra takes).
- `tempo` passed to `gb_record_sequence` MUST equal the project tempo, or notes land between gridlines.
- One take per track. A second take on the same track at the same bars overwrites/merges confusingly — add a track instead, or `gb_undo` the bad take first.
- To record a layer at a later section, `gb_set_playhead {bar: 17}` first.

## 4. Composing: writing music that sounds good

The sequence format is a beat grid: `startBeat`, `durationBeats`, fractions welcome. Everything musical is your job. The craft:

**Velocity is the instrument.** Flat velocity-100 everywhere sounds like a ringtone. Real ranges: ghost notes 40–60, normal 70–95, accents 100–115, climax hits 115–127. Give every bar a shape: accent beat 1, lighter offbeats, crescendo into section changes. Look at `examples/edm-anthem.json` — the build works *because* of velocity ramps.

**Song structure.** Sections of 4/8 bars: intro (sparse) → build (add layers, raise velocity, subdivide rhythms) → drop/chorus (everything lands on the downbeat together, crash cymbal) → breakdown (strip back) → outro. Signal section changes: a crash on the first beat, a snare roll or riser in the last bar before.

**The classic devices**, all expressible with plain events:
- *Riser*: ascending 16th-note scale run, velocity 50→127, into the downbeat
- *Fall*: same descending, velocity fading
- *Build roll*: snare 8ths → 16ths across two bars, velocity ramping
- *Swell*: repeated string bows, 2 beats each, velocity stepping up (cinematic-swell.json)
- *Filter sweep*: `{cc: {controller: 1, value: 0, endValue: 127}, startBeat: 8, durationBeats: 8}` — mod wheel opens the filter/vibrato on most synth patches across the build
- *Pitch drop*: `{bend: {value: 0, endValue: -1}, startBeat: 15, durationBeats: 1}` then a bend back to 0 — send `{bend: {value: 0}}` after, or hanging bend detunes everything that follows (panic resets it too)

**Tempo as expression.** `tempoMap` does instant changes and linear ramps. Ritardando ending: pin the tempo first, then ramp — `[{beat: 32, bpm: 128}, {beat: 40, bpm: 92, ramp: true}]`. Without the pin, the ramp starts from beat 0.

**Drums**: aliases `kick snare rimshot clap hihat openhat pedalhat crash ride tomlow tommid tomhigh cowbell tambourine shaker`. Groove skeleton: kick on 1 and 3 (or four-on-floor for dance), snare/clap on 2 and 4, hats subdividing, open hat on offbeats for drive. Ghost snares (vel 50) just before the backbeat add pocket.

**Register discipline**: bass C1–C3 (keep it monophonic), chords C3–C5, melody C4–C6. When layers collide in the same octave the mix turns to mud.

**Audition before you record.** `gb_play_sequence` streams without recording — hear it (on the currently selected instrument), fix it, *then* `gb_record_sequence`. Iterating on recorded takes costs undo cycles.

## 5. Sound design: Smart Controls

GarageBand's Smart Controls are the macro knobs of the underlying synth/instrument — filter cutoff, resonance, envelope attack/release, effect sends. The workflow is always **discover, then set**:

```
gb_toggle_smart_controls           → open the pane (B)
gb_list_smart_controls             → what does THIS patch expose? (names + values)
gb_set_smart_control {control: "Cutoff", value: 0.35}
gb_play_note                       → audition the change
```

Never guess knob names — patches differ wildly (a synth exposes Cutoff/Resonance/Attack; an e-piano exposes Bell/Drive/Chorus). Values are normalized 0–1. Typical moves: darker pad = cutoff down to 0.3; softer attack for strings = attack up; less mud = reduce reverb send on bass.

For *time-varying* sound shaping during a performance, use CC events in sequences instead (mod wheel = CC1 is mapped on most patches).

## 6. Mixing

Rough levels first, then balance while playing (`gb_play`, adjust, `gb_stop`):

- Start every track at 71 (= 0 dB unity). Levels are 0–100.
- Drums and bass carry the track: keep them 65–75. Pads/harmony sit lower: 50–60. Lead melody just above the bed: 60–70.
- Pan (−100..100): kick/snare/bass/lead center (0). Hats 20–35, pads split ±30–50, strings wide. Two similar layers? Pan them apart.
- `gb_set_master_volume 71`; if the mix clips, lower *track* levels, not just master.
- `gb_mute_selected_track` / `gb_solo_selected_track` (after `gb_select_track {index}`) to check a layer in isolation.

## 7. Apple Loops

GarageBand ships thousands of royalty-free loops — real recorded phrases that auto-conform to project tempo. Great for texture you can't easily synthesize (live drum feels, guitar strums, vocal chops):

```
gb_search_loops {query: "funk bass"}   → names list; clicking a result in GB previews it
gb_add_loop {name: "..."}              → drags it in; GarageBand creates a new track, loop lands near bar 1
gb_screenshot                          → VERIFY the drop — drag-and-drop is the least reliable operation here
gb_undo                                → if it landed wrong
```

Loops + recorded MIDI layers mix freely. To reposition a loop precisely, tell the user — region dragging is not yet reliable enough to automate.

## 7.5 Importing open-source MIDI & samples

**MIDI → GarageBand, fully automated.** `gb_import_midi {url}` parses any open-licensed `.mid` into layers; then it's the standard golden path with the composition already written:

```
gb_import_midi {url: "https://.../bach-invention-1.mid"}   → summary: tempo, layers, note counts
gb_set_tempo {bpm: <the import's tempo>}                    ← MUST match, or notes land off-grid
gb_play_imported                                            ← audition the whole piece first
For each layer worth keeping:
  gb_add_software_instrument_track → gb_set_track_instrument → gb_record_imported {layer: N}
```

The import summary flags truncation and tempo changes. `gb_imported_events {layer}` returns raw events when you want to trim, transpose, or re-voice before recording (edit them, then use plain `gb_record_sequence`). Skip near-empty layers; classical piano MIDI often splits left/right hand into two layers — two tracks with the same piano patch is faithful.

**Licensing is your responsibility.** Use public-domain/CC sources — Mutopia Project, piano-midi.de, Wikimedia Commons. Most "free MIDI" sites host transcriptions of copyrighted songs; do not pull those. When a source requires attribution, put the credit in your response and suggest the user keep it with the exported music.

**Audio samples** via Freesound (needs `FREESOUND_API_KEY` — if it's missing, the error tells the user how to get one). `gb_search_freesound` defaults to CC0; `gb_download_sample` saves an MP3 to `~/Music/GarageBand MCP Samples/` and reports any required credit. You cannot script the import — tell the user to drag the file from Finder into the tracks area, and pass along the attribution line for CC-BY sounds.

## 8. Error recovery

Every error carries a `[CODE]` and a hint. The playbook:

| Code | Meaning | Your move |
|---|---|---|
| `NO_AX_PERMISSION` | Accessibility not granted | Stop. Relay the error's System Settings instructions to the user — you cannot fix this yourself |
| `NOT_RUNNING` | GarageBand closed | `gb_launch` |
| `NO_PROJECT` | Nothing open / chooser showing | `gb_new_project` or `gb_open_project` |
| `OSASCRIPT_TIMEOUT` | A modal is blocking | `gb_ui_state` → `gb_screenshot` → dismiss (usually `Return` accepts / `Escape` cancels via the dialog tools) |
| `DIALOG_UNEXPECTED` | Sheet layout ≠ expected | The error includes the sheet's actual buttons/fields — adapt using those exact names |
| `ELEMENT_NOT_FOUND` | AX element missing | Usually a closed pane (Smart Controls, Library, Loops) — open it and retry; the error often lists what *was* found |
| `EXPORT_TIMEOUT` | File never appeared | Export may still be running or went to the last-used folder — `gb_ui_state`, then check `~/Music` |
| `MIDI_INIT_FAILED` | CoreMIDI refused | Rare; retry once, then report to the user |

General rules: after any failed compose/record call, notes can't hang (the server panics automatically) but the transport might still be rolling — `gb_stop` costs nothing. `gb_undo` is your safety net after any action that changed the project. When two attempts at a UI flow fail the same way, stop and show the user a screenshot instead of hammering a third time.

## 9. What this server cannot do (yet)

Be straight with users about these — offer the workaround:

- **Edit recorded notes** (piano-roll editing). Workaround: `gb_undo` and re-record the corrected sequence — regenerating MIDI is cheap for you.
- **Automation curves** (volume/pan over time). Workaround: velocity shaping and CC ramps at record time; or static per-section mixes.
- **Move/copy/trim regions** on the timeline. Workaround: compose sequences at final length; use `gb_set_playhead` to record sections in place.
- **Choose specific per-track plugins/amps** beyond what patches + Smart Controls give you.
- **Real audio recording** (mic input) — `gb_add_track {type:"audio"}` creates the track, but the user records into it.
- Multiple simultaneous live instruments (one selected track gets all MIDI).

## 10. Quick reference: a complete session

```json
// 90 BPM lo-fi beat, three layers, mixed and exported
gb_check_permissions → gb_launch → gb_new_project → gb_set_tempo {"bpm": 90}
gb_toggle_count_in

gb_set_track_instrument {"instrument": "Drum Kit", "trackIndex": 1}
gb_record_sequence {"tempo": 90, "events": [/* kick 1&3, snare 2&4 vel 95, hats 8ths vel 55-70, ghost snare 2.75 vel 45 */]}

gb_add_software_instrument_track
gb_set_track_instrument {"instrument": "Upright Studio Bass", "trackIndex": 2}
gb_record_sequence {"tempo": 90, "events": [/* roots C2-A1, syncopated, vel 85-105 */]}

gb_add_software_instrument_track
gb_set_track_instrument {"instrument": "Electric Piano", "trackIndex": 3}
gb_toggle_smart_controls → gb_list_smart_controls → gb_set_smart_control {"control": "Treble", "value": 0.3}
gb_record_sequence {"tempo": 90, "events": [/* Fmaj7 Em7 Dm7 Cmaj7, whole bars, vel 60-75 */]}

gb_set_track_volume {"trackIndex": 1, "level": 72} → {"trackIndex": 2, "level": 68} → {"trackIndex": 3, "level": 58}
gb_set_track_pan {"trackIndex": 3, "pan": 25}
gb_go_to_beginning → gb_play → /* listen */ → gb_stop
gb_save_project {"name": "lofi-sketch"} → gb_export_song {"filename": "lofi-sketch", "format": "mp3"}
```

The bar you're aiming for: someone opens the project afterwards and it looks and sounds like a musician made it — named tracks with the right instruments, regions starting at bar 1, a mix that breathes, and a bounce that's pleasant to hear. That's the standard.
