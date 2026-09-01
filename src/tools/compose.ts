import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, guarded } from "../errors.js";
import * as ui from "../ui.js";
import { sleep } from "../osa.js";
import { noteOn, noteOff, panic } from "../midi.js";
import {
  parseNote,
  noteValue,
  sequenceEvent,
  compileSequence,
  sequenceLengthBeats,
  msPerBeat,
  type SequenceEvent,
} from "../music.js";
import { playCompiled, cancelActive } from "../scheduler.js";

const NOTE_TAIL_MS = 400; // let releases ring before we stop the transport

async function playEvents(events: SequenceEvent[], bpm: number): Promise<number> {
  const compiled = compileSequence(events, bpm);
  await playCompiled(compiled);
  return compiled.length / 2;
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
        events: z.array(sequenceEvent).min(1),
      },
    },
    async ({ tempo, events }) =>
      guarded(async () => {
        const bpm = tempo ?? 120;
        const n = await playEvents(events, bpm);
        return ok(
          `Played ${n} notes over ${sequenceLengthBeats(events).toFixed(2)} beats at ${bpm} BPM.`,
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
    async ({ tempo, events, countInBars, beatsPerBar, startLatencyMs }) =>
      guarded(async () => {
        const bpm = tempo ?? 120;
        const bars = countInBars ?? 1;
        const bpb = beatsPerBar ?? 4;
        const beatMs = msPerBeat(bpm);
        try {
          await ui.ensureReady({ needsProject: true });
          await ui.keyCode(ui.KEY.RETURN); // playhead to beginning
          await sleep(300);
          await ui.keystroke("r"); // start recording
          const waitMs = bars * bpb * beatMs + (startLatencyMs ?? 150);
          await sleep(waitMs);
          const n = await playEvents(events, bpm);
          await sleep(NOTE_TAIL_MS);
          await ui.keyCode(ui.KEY.SPACE); // stop
          return ok(
            `Recorded ${n} notes (${sequenceLengthBeats(events).toFixed(2)} beats at ${bpm} BPM) onto the selected track. ` +
              "Press gb_go_to_beginning + gb_play to hear it. If timing is off, adjust startLatencyMs or verify the project tempo and count-in setting match the parameters.",
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
