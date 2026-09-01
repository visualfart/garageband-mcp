import { z } from "zod";
import { GBError } from "./errors.js";

const SEMITONES: Record<string, number> = {
  C: 0, "C#": 1, DB: 1, D: 2, "D#": 3, EB: 3, E: 4, FB: 4, "E#": 5,
  F: 5, "F#": 6, GB: 6, G: 7, "G#": 8, AB: 8, A: 9, "A#": 10, BB: 10,
  B: 11, CB: 11, "B#": 0,
};

/** Common General MIDI drum aliases (usable on a Drum Kit track). */
const DRUMS: Record<string, number> = {
  KICK: 36, SNARE: 38, RIMSHOT: 37, CLAP: 39, HIHAT: 42, CLOSEDHAT: 42,
  OPENHAT: 46, PEDALHAT: 44, CRASH: 49, RIDE: 51, TOMLOW: 41, TOMMID: 45,
  TOMHIGH: 48, COWBELL: 56, TAMBOURINE: 54, SHAKER: 70,
};

/** Parse "C4", "F#3", "Bb2", a drum alias like "kick", or a raw MIDI number (0–127). */
export function parseNote(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input < 0 || input > 127) {
      throw new GBError("INVALID_INPUT", `MIDI note number out of range: ${input}`);
    }
    return input;
  }
  const upper = input.trim().toUpperCase();
  if (upper in DRUMS) return DRUMS[upper];
  const m = upper.match(/^([A-G][#B]?)(-?\d)$/);
  if (!m) {
    throw new GBError(
      "INVALID_INPUT",
      `Cannot parse note "${input}".`,
      'Use a name like "C4" or "F#3", a drum alias like "kick"/"snare"/"hihat", or a MIDI number 0-127.',
    );
  }
  const semitone = SEMITONES[m[1]];
  const octave = parseInt(m[2], 10);
  const midi = (octave + 1) * 12 + semitone;
  if (midi < 0 || midi > 127) {
    throw new GBError("INVALID_INPUT", `Note "${input}" is out of MIDI range.`);
  }
  return midi;
}

export const noteValue = z.union([z.string(), z.number()]);

export const sequenceEvent = z
  .object({
    note: noteValue.optional().describe('Single note: "C4", "kick", or MIDI number'),
    notes: z.array(noteValue).optional().describe("Multiple simultaneous notes (a chord)"),
    startBeat: z.number().min(0).describe("Start position in beats from 0"),
    durationBeats: z.number().positive().describe("Length in beats"),
    velocity: z.number().int().min(1).max(127).optional().describe("1-127, default 100"),
    channel: z.number().int().min(1).max(16).optional().describe("MIDI channel 1-16, default 1"),
  })
  .describe("One note or chord placed on the beat grid");

export type SequenceEvent = z.infer<typeof sequenceEvent>;

export interface MidiEvent {
  tMs: number;
  type: "on" | "off";
  note: number;
  velocity: number;
  channel: number; // 0-based
}

export function msPerBeat(bpm: number): number {
  return 60_000 / bpm;
}

export const tempoPoint = z
  .object({
    beat: z.number().min(0).describe("Beat at which this tempo applies"),
    bpm: z.number().min(20).max(300),
    ramp: z
      .boolean()
      .optional()
      .describe(
        "Glide linearly from the previous tempo, arriving at this bpm exactly on this beat (accelerando/ritardando). Without it the change is instant.",
      ),
  })
  .describe(
    'Tempo change. To ramp only near the end, pin the old tempo first: [{beat:32,bpm:128},{beat:40,bpm:92,"ramp":true}]',
  );

export type TempoPoint = z.infer<typeof tempoPoint>;

interface TempoSegment {
  s: number; // start beat
  e: number; // end beat
  a: number; // bpm at s
  b: number; // bpm at e (== a for constant segments)
  t0: number; // absolute ms at s
}

// time to traverse [s, x] of a segment whose bpm moves linearly a -> b over [s, e]
function segmentMs(seg: TempoSegment, x: number): number {
  const { s, e, a, b } = seg;
  if (x <= s) return 0;
  if (Math.abs(b - a) < 1e-9 || !isFinite(e)) return ((x - s) * 60_000) / a;
  const k = (b - a) / (e - s);
  const bpmX = a + k * (x - s);
  return (60_000 / k) * Math.log(bpmX / a);
}

/**
 * Build a beat→ms clock from a base tempo and an optional tempo map.
 * Ramped points integrate 1/bpm in closed form, so ramps stay exact.
 */
export function makeBeatClock(baseBpm: number, map: TempoPoint[] = []): (beat: number) => number {
  const pts = [...map].sort((x, y) => x.beat - y.beat);
  const segs: TempoSegment[] = [];
  let curBeat = 0;
  let curBpm = baseBpm;
  let t = 0;
  for (const p of pts) {
    if (p.beat > curBeat) {
      const endBpm = p.ramp ? p.bpm : curBpm;
      const seg: TempoSegment = { s: curBeat, e: p.beat, a: curBpm, b: endBpm, t0: t };
      segs.push(seg);
      t += segmentMs(seg, p.beat);
      curBeat = p.beat;
    }
    curBpm = p.bpm;
  }
  segs.push({ s: curBeat, e: Infinity, a: curBpm, b: curBpm, t0: t });
  return (beat: number) => {
    const seg =
      segs.find((sg) => beat >= sg.s && beat < sg.e) ?? segs[segs.length - 1];
    return seg.t0 + segmentMs(seg, beat);
  };
}

/** Compile beat-grid events into a sorted absolute-time MIDI event list. */
export function compileSequence(
  events: SequenceEvent[],
  bpm: number,
  tempoMap: TempoPoint[] = [],
): MidiEvent[] {
  const clock = makeBeatClock(bpm, tempoMap);
  const out: MidiEvent[] = [];
  for (const ev of events) {
    const rawNotes = ev.notes ?? (ev.note !== undefined ? [ev.note] : []);
    if (rawNotes.length === 0) {
      throw new GBError("INVALID_INPUT", "Each event needs a `note` or a `notes` array.");
    }
    const velocity = ev.velocity ?? 100;
    const channel = (ev.channel ?? 1) - 1;
    for (const n of rawNotes) {
      const note = parseNote(n);
      const start = clock(ev.startBeat);
      // note-off lands 5ms early so repeated notes never collide on the same tick
      const end = Math.max(start + 10, clock(ev.startBeat + ev.durationBeats) - 5);
      out.push({ tMs: start, type: "on", note, velocity, channel });
      out.push({ tMs: end, type: "off", note, velocity: 0, channel });
    }
  }
  out.sort((a, b) => a.tMs - b.tMs || (a.type === "off" ? -1 : 1));
  return out;
}

export const songLayer = z
  .object({
    name: z.string().optional().describe('e.g. "drums", "bass", "strings"'),
    channel: z
      .number()
      .int()
      .min(1)
      .max(16)
      .optional()
      .describe("Default MIDI channel for this layer's events"),
    events: z.array(sequenceEvent).min(1),
  })
  .describe("One instrument part of a multi-layer song");

export type SongLayer = z.infer<typeof songLayer>;

/** Merge song layers (applying each layer's default channel) into one event list. */
export function mergeLayers(layers: SongLayer[]): SequenceEvent[] {
  return layers.flatMap((layer) =>
    layer.events.map((ev) => ({ ...ev, channel: ev.channel ?? layer.channel ?? 1 })),
  );
}

export function sequenceLengthBeats(events: SequenceEvent[]): number {
  return events.reduce((max, e) => Math.max(max, e.startBeat + e.durationBeats), 0);
}
