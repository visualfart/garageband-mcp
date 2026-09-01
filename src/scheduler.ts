import type { MidiEvent } from "./music.js";
import { noteOn, noteOff, panic } from "./midi.js";

const TICK_MS = 25;
const LOOKAHEAD_MS = 5;

let activeCancel: (() => void) | null = null;

/**
 * Play a compiled event list against the wall clock. Events are anchored to an
 * absolute start time (hrtime), so jitter stays bounded instead of accumulating.
 */
export function playCompiled(events: MidiEvent[]): Promise<void> {
  cancelActive();
  return new Promise((resolve) => {
    if (events.length === 0) {
      resolve();
      return;
    }
    const t0 = process.hrtime.bigint();
    let idx = 0;
    const timer = setInterval(() => {
      const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
      while (idx < events.length && events[idx].tMs <= elapsed + LOOKAHEAD_MS) {
        const ev = events[idx++];
        if (ev.type === "on") noteOn(ev.note, ev.velocity, ev.channel);
        else noteOff(ev.note, ev.channel);
      }
      if (idx >= events.length) {
        clearInterval(timer);
        activeCancel = null;
        resolve();
      }
    }, TICK_MS);
    activeCancel = () => {
      clearInterval(timer);
      panic();
      activeCancel = null;
      resolve();
    };
  });
}

/** Cancel any in-flight sequence and silence hanging notes. Returns true if one was active. */
export function cancelActive(): boolean {
  if (activeCancel) {
    activeCancel();
    return true;
  }
  return false;
}
