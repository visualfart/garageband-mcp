import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, guarded, GBError } from "../errors.js";
import * as ui from "../ui.js";
import { sleep } from "../osa.js";
import { noteOn, noteOff, sendCC, sendPitchBend, panic } from "../midi.js";
import {
  parseNote,
  noteValue,
  sequenceEvent,
  tempoPoint,
  songLayer,
  mergeLayers,
  compileSequence,
  sequenceLengthBeats,
  msPerBeat,
  type SequenceEvent,
  type TempoPoint,
} from "../music.js";
import { playCompiled, cancelActive } from "../scheduler.js";
import { rewindVerified } from "./transport.js";

const NOTE_TAIL_MS = 400; // let releases ring before we stop the transport

export async function playEvents(
  events: SequenceEvent[],
  bpm: number,
  tempoMap: TempoPoint[] = [],
): Promise<number> {
  const compiled = compileSequence(events, bpm, tempoMap);
  await playCompiled(compiled);
  return compiled.length / 2;
}

export interface RecordOpts {
  tempo?: number;
  tempoMap?: TempoPoint[];
  countInBars?: number;
  beatsPerBar?: number;
  startLatencyMs?: number;
}

/** The full record flow: verified rewind → record → count-in → stream → stop. */
export async function recordSequenceFlow(events: SequenceEvent[], opts: RecordOpts): Promise<string> {
  const bpm = opts.tempo ?? 120;
  const bars = opts.countInBars ?? 1;
  const bpb = opts.beatsPerBar ?? 4;
  const beatMs = msPerBeat(bpm);
  try {
    await ui.ensureReady({ needsProject: true });
    // rewind and VERIFY via the LCD position readout — an unverified
    // rewind silently shifts each layer further right on the timeline
    const pos = await rewindVerified();
    if (pos !== null && pos > 1.01) {
      throw new GBError(
        "ELEMENT_NOT_FOUND",
        `Playhead still reads position ${pos} after rewinding — recording would land at the wrong bar.`,
        "Check gb_ui_state / gb_screenshot for a dialog or focused field swallowing keystrokes, then retry.",
      );
    }
    await ui.keystroke("r"); // start recording
    const waitMs = bars * bpb * beatMs + (opts.startLatencyMs ?? 150);
    await sleep(waitMs);
    const n = await playEvents(events, bpm, opts.tempoMap ?? []);
    await sleep(NOTE_TAIL_MS);
    await ui.keyCode(ui.KEY.SPACE); // stop
    return (
      `Recorded ${n} notes (${sequenceLengthBeats(events).toFixed(2)} beats at ${bpm} BPM) onto the selected track. ` +
      "Press gb_go_to_beginning + gb_play to hear it. If timing is off, adjust startLatencyMs or verify the project tempo and count-in setting match the parameters."
    );
  } catch (e) {
    // never leave the transport recording or notes hanging on failure
    panic();
    try {
      await ui.keyCode(ui.KEY.SPACE);
    } catch {
      /* best effort */
    }
    throw e;
  }
}

export function registerComposeTools(server: McpServer): void {
  server.registerTool(
    "gb_play_note",
    {
      title: "Play a note",
      description:
        "Play a single note into GarageBand via the virtual MIDI port. The selected software-instrument track sounds it live (no recording). Great for auditioning sounds.",
      inputSchema: {
        note: noteValue.describe('"C4", "F#3", "kick", or MIDI number 0-127'),
        velocity: z.number().int().min(1).max(127).optional().describe("Default 100"),
        durationMs: z.number().int().min(20).max(10000).optional().describe("Default 500"),
        channel: z.number().int().min(1).max(16).optional().describe("Default 1"),
      },
    },
    async ({ note, velocity, durationMs, channel }) =>
      guarded(async () => {
        const n = parseNote(note);
        const ch = (channel ?? 1) - 1;
        noteOn(n, velocity ?? 100, ch);
        await sleep(durationMs ?? 500);
        noteOff(n, ch);
        return ok(`Played MIDI note ${n}.`);
      }),
  );

  server.registerTool(
    "gb_play_chord",
    {
      title: "Play a chord",
      description: "Play several notes simultaneously into GarageBand (live, no recording).",
      inputSchema: {
        notes: z.array(noteValue).min(1).describe('e.g. ["C4","E4","G4"]'),
        velocity: z.number().int().min(1).max(127).optional(),
        durationMs: z.number().int().min(20).max(10000).optional().describe("Default 800"),
        channel: z.number().int().min(1).max(16).optional(),
      },
    },
    async ({ notes, velocity, durationMs, channel }) =>
      guarded(async () => {
        const parsed = notes.map(parseNote);
        const ch = (channel ?? 1) - 1;
        for (const n of parsed) noteOn(n, velocity ?? 100, ch);
        await sleep(durationMs ?? 800);
        for (const n of parsed) noteOff(n, ch);
        return ok(`Played chord [${parsed.join(", ")}].`);
      }),
  );

  server.registerTool(
    "gb_play_sequence",
    {
      title: "Play a sequence",
      description:
        "Play a beat-grid sequence of notes/chords into GarageBand live (no recording). Events have startBeat + durationBeats; tempo converts beats to time.",
      inputSchema: {
        tempo: z.number().min(40).max(240).optional().describe("BPM, default 120"),
        tempoMap: z
          .array(tempoPoint)
          .optional()
          .describe("Tempo changes/ramps during the sequence (accelerando, ritardando)"),
        events: z.array(sequenceEvent).min(1),
      },
    },
    async ({ tempo, tempoMap, events }) =>
      guarded(async () => {
        const bpm = tempo ?? 120;
        const n = await playEvents(events, bpm, tempoMap ?? []);
        return ok(
          `Played ${n} notes over ${sequenceLengthBeats(events).toFixed(2)} beats at ${bpm} BPM${tempoMap?.length ? ` with ${tempoMap.length} tempo changes` : ""}.`,
        );
      }),
  );

  server.registerTool(
    "gb_play_song",
    {
      title: "Play a multi-layer song",
      description:
        "Play a full arrangement — multiple named layers (drums, bass, strings, lead, FX) merged and streamed together, with optional tempo changes/ramps. NOTE: GarageBand routes all live MIDI to the one selected track, so this auditions the whole mix on a single instrument. For a real multi-instrument arrangement, record each layer onto its own track with gb_record_sequence (passing that layer's events), adding tracks in between.",
      inputSchema: {
        tempo: z.number().min(40).max(240).optional().describe("Base BPM, default 120"),
        tempoMap: z.array(tempoPoint).optional(),
        layers: z.array(songLayer).min(1),
      },
    },
    async ({ tempo, tempoMap, layers }) =>
      guarded(async () => {
        const bpm = tempo ?? 120;
        const merged = mergeLayers(layers);
        const n = await playEvents(merged, bpm, tempoMap ?? []);
        const names = layers.map((l, i) => l.name ?? `layer ${i + 1}`).join(", ");
        return ok(
          `Played ${n} notes across ${layers.length} layers (${names}) over ${sequenceLengthBeats(merged).toFixed(2)} beats at ${bpm} BPM${tempoMap?.length ? ` with ${tempoMap.length} tempo changes` : ""}.`,
        );
      }),
  );

  server.registerTool(
    "gb_record_sequence",
    {
      title: "Record a sequence",
      description:
        "Compose INTO the project: moves the playhead to the beginning, starts recording on the selected software-instrument track, streams the sequence as MIDI in time, then stops. Set the project tempo to match (gb_set_tempo) and turn on count-in (gb_toggle_count_in) for tight alignment. The tempo parameter here must match the PROJECT tempo.",
      inputSchema: {
        tempo: z
          .number()
          .min(40)
          .max(240)
          .optional()
          .describe("Project BPM (must match GarageBand's tempo), default 120"),
        tempoMap: z
          .array(tempoPoint)
          .optional()
          .describe(
            "Expressive tempo changes for the performance (the recorded notes keep their real timing; GarageBand's grid stays at the project tempo)",
          ),
        events: z.array(sequenceEvent).min(1),
        countInBars: z
          .number()
          .int()
          .min(0)
          .max(4)
          .optional()
          .describe("Bars of count-in GarageBand is set to (default 1; 0 if count-in is off)"),
        beatsPerBar: z.number().int().min(1).max(12).optional().describe("Time signature top number, default 4"),
        startLatencyMs: z
          .number()
          .int()
          .min(0)
          .max(2000)
          .optional()
          .describe("Extra delay after pressing record before streaming (tuning aid, default 150)"),
      },
    },
    async ({ tempo, tempoMap, events, countInBars, beatsPerBar, startLatencyMs }) =>
      guarded(async () =>
        ok(await recordSequenceFlow(events, { tempo, tempoMap, countInBars, beatsPerBar, startLatencyMs })),
      ),
  );

  server.registerTool(
    "gb_send_cc",
    {
      title: "Send MIDI CC",
      description:
        "Send a control-change message to the selected track's instrument: 1 = mod wheel (vibrato/filter on many patches), 64 = sustain pedal (127 on / 0 off), 74 = filter cutoff on some synths. For CC ramps over time, use cc events inside gb_play_sequence / gb_record_sequence instead.",
      inputSchema: {
        controller: z.number().int().min(0).max(127),
        value: z.number().int().min(0).max(127),
        channel: z.number().int().min(1).max(16).optional(),
      },
    },
    async ({ controller, value, channel }) =>
      guarded(async () => {
        sendCC(controller, value, (channel ?? 1) - 1);
        return ok(`Sent CC${controller} = ${value}.`);
      }),
  );

  server.registerTool(
    "gb_pitch_bend",
    {
      title: "Pitch bend",
      description:
        "Set the pitch-bend wheel: -1 = full down, 0 = center, 1 = full up (range is patch-defined, usually ±2 semitones). Remember to return it to 0. For bend curves over time, use bend events inside sequences.",
      inputSchema: {
        value: z.number().min(-1).max(1),
        channel: z.number().int().min(1).max(16).optional(),
      },
    },
    async ({ value, channel }) =>
      guarded(async () => {
        sendPitchBend(value, (channel ?? 1) - 1);
        return ok(`Pitch bend at ${value}.`);
      }),
  );

  server.registerTool(
    "gb_all_notes_off",
    {
      title: "All notes off (panic)",
      description: "Cancel any playing sequence and silence all MIDI notes (CC123 panic).",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const wasActive = cancelActive();
        panic();
        return ok(wasActive ? "Sequence cancelled and all notes silenced." : "All notes silenced.");
      }),
  );
}
