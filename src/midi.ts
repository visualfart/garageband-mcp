import easymidi from "easymidi";
import { GBError } from "./errors.js";

const PORT_NAME = "GarageBand MCP";

let output: easymidi.Output | null = null;
const sounding = new Set<string>(); // "note:channel" pairs currently held down

/** Lazily create the virtual CoreMIDI source. GarageBand auto-connects to it. */
export function getOutput(): easymidi.Output {
  if (output) return output;
  try {
    output = new easymidi.Output(PORT_NAME, true);
  } catch (e) {
    throw new GBError(
      "MIDI_INIT_FAILED",
      `Could not create virtual MIDI port: ${e instanceof Error ? e.message : e}`,
    );
  }
  return output;
}

export function noteOn(note: number, velocity: number, channel: number): void {
  getOutput().send("noteon", { note, velocity, channel });
  sounding.add(`${note}:${channel}`);
}

export function noteOff(note: number, channel: number): void {
  getOutput().send("noteoff", { note, velocity: 0, channel });
  sounding.delete(`${note}:${channel}`);
}

/** Silence everything: explicit note-offs for held notes, then CC123 on all channels. */
export function panic(): void {
  if (!output) return;
  for (const key of sounding) {
    const [note, channel] = key.split(":").map(Number);
    output.send("noteoff", { note, velocity: 0, channel });
  }
  sounding.clear();
  for (let ch = 0; ch < 16; ch++) {
    output.send("cc", { controller: 123, value: 0, channel: ch });
  }
}

export function closeMidi(): void {
  if (output) {
    try {
      panic();
      output.close();
    } catch {
      // shutting down anyway
    }
    output = null;
  }
}
