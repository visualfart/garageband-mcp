# Workflows

End-to-end recipes combining the server's tools — each one is a real session an agent (or you, via any MCP client) can run. Tool-call sequences are abbreviated; [AGENTS.md](../AGENTS.md) has the full discipline around each step.

## 1. From the internet to a GarageBand project (MIDI import)

Take a public-domain piece from the Mutopia Project and turn it into a playable GarageBand project:

```
gb_import_midi {url: "https://www.mutopiaproject.org/ftp/BachJS/BWV846/wtk1-prelude1/wtk1-prelude1.mid"}
   → "Tempo: 60 BPM · 549 notes · Layers: 1. lower (134 notes), 2. upper (415 notes)"

gb_new_project
gb_set_tempo {bpm: 60}                                 ← match the import's tempo
gb_play_imported                                        ← audition the whole piece first

gb_set_track_instrument {instrument: "Steinway Grand Piano", trackIndex: 1}
gb_record_imported {layer: 1}                           ← left hand
gb_add_software_instrument_track
gb_set_track_instrument {instrument: "Steinway Grand Piano", trackIndex: 2}
gb_record_imported {layer: 2}                           ← right hand

gb_save_project {name: "bach-prelude"} → gb_export_song {filename: "bach-prelude", format: "aac"}
```

Want to reorchestrate? Give layer 2 to "Cinematic Strings" instead — the notes don't care. To edit before recording (trim, transpose), pull the raw events with `gb_imported_events {layer: 2}` and record the edited list with plain `gb_record_sequence`.

Sources that are safe to pull from: [Mutopia Project](https://www.mutopiaproject.org) (public domain), [piano-midi.de](http://www.piano-midi.de) (CC classical performances), Wikimedia Commons. Avoid "free MIDI" sites hosting transcriptions of copyrighted songs.

## 2. Apple Loops + your MIDI

Let a real recorded loop carry the feel, and compose around it:

```
gb_new_project → gb_set_tempo {bpm: 90}
gb_search_loops {query: "hip hop beat"}        → list of loop names
gb_add_loop {name: "80s Hip Hop Beat 01"}      → new track, loop lands near bar 1
gb_screenshot                                   ← VERIFY the drop (drag-and-drop is the flakiest op)
gb_play → listen to the loop at project tempo → gb_stop

gb_add_software_instrument_track
gb_set_track_instrument {instrument: "Upright Studio Bass", trackIndex: 2}
gb_record_sequence {tempo: 90, events: [/* bassline written to sit in the loop's pockets */]}

gb_add_software_instrument_track
gb_set_track_instrument {instrument: "Electric Piano", trackIndex: 3}
gb_record_sequence {tempo: 90, events: [/* chords */]}
```

Loops auto-conform to project tempo, so set tempo *before* adding them. If a loop lands wrong: `gb_undo`, retry, or leave placement to the user.

## 3. Freesound texture under a beat

Layer a CC0 field-recording or vinyl texture under composed MIDI (needs `FREESOUND_API_KEY`, see the README):

```
gb_search_freesound {query: "vinyl crackle"}    → CC0 results with ids
gb_download_sample {id: 398816}                 → saved to ~/Music/GarageBand MCP Samples/
   → the user drags the file from Finder into the tracks area (audio import can't be scripted)

/* meanwhile, record the lo-fi beat around it: */
gb_set_track_instrument {instrument: "Drum Kit", trackIndex: 1} → gb_record_sequence {...}
gb_add_software_instrument_track → gb_set_track_instrument {instrument: "Electric Piano", trackIndex: 2} → gb_record_sequence {...}
```

CC0 sounds need no credit; for CC-BY the download reports the required attribution — keep it with the exported music.

## 4. Sound-design pass (Smart Controls + expression)

Shape the actual synth sound, then perform the movement into the recording:

```
gb_select_track {index: 2}                       ← the synth layer
gb_toggle_smart_controls → gb_list_smart_controls
   → "Cutoff = 0.62, Resonance = 0.3, Attack = 0.1, ..."
gb_set_smart_control {control: "Cutoff", value: 0.3}     ← darker starting point
gb_play_note {note: "C2"}                                 ← audition

/* record with the filter opening across the build — CC74 ramp inside the sequence: */
gb_record_sequence {tempo: 130, events: [
  /* ...bass notes... */,
  {"cc": {"controller": 74, "value": 25, "endValue": 120}, "startBeat": 0, "durationBeats": 8}
]}
```

`examples/acid-techno.json` is exactly this pattern. Mod wheel (CC1) works on more patches than CC74 — try it first if the sweep does nothing.

## 5. Full production, start to export

The complete golden path — compose original multi-layer music and deliver an audio file:

```
gb_check_permissions → gb_launch → gb_new_project
gb_set_tempo {bpm: ...} → gb_toggle_count_in
for each layer (drums → bass → harmony → melody):
    gb_add_software_instrument_track        (skip for the first — new projects have one)
    gb_set_track_instrument {...}
    gb_play_sequence {...}                  ← audition, fix, then commit:
    gb_record_sequence {...}
gb_set_track_volume / gb_set_track_pan per track
gb_go_to_beginning → gb_play → listen → gb_stop
gb_save_project {name: ...} → gb_export_song {filename: ..., format: "mp3"}
```

Any example in this folder can be the composition: `examples/play.mjs <file> --record --layer <name>` records one layer at a time, or an agent passes each layer's events to `gb_record_sequence`.
