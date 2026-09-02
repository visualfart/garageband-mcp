import { GBError } from "./errors.js";
import type { SequenceEvent, TempoPoint, SongLayer } from "./music.js";

/**
 * Minimal Standard MIDI File (SMF) parser — enough to turn open-source .mid
 * files into this server's sequence format: note on/off pairing, set-tempo
 * metas, track names. Format 0 and 1, PPQ division only.
 */

interface ParsedNote {
  tick: number;
  durTicks: number;
  note: number;
  velocity: number;
  channel: number; // 0-based
}

interface ParsedTrack {
  name: string | null;
  notes: ParsedNote[];
}

interface ParsedSMF {
  division: number; // pulses per quarter note
  tracks: ParsedTrack[];
  tempos: Array<{ tick: number; bpm: number }>;
}

export interface ImportedSong {
  tempo: number;
  tempoMap: TempoPoint[];
  layers: SongLayer[];
  totalNotes: number;
  lengthBeats: number;
  truncated: boolean;
}

class Reader {
  pos = 0;
  constructor(private buf: Buffer) {}
  u8(): number {
    return this.buf[this.pos++];
  }
  u16(): number {
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  bytes(n: number): Buffer {
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  varlen(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
    return v;
  }
  get eof(): boolean {
    return this.pos >= this.buf.length;
  }
}

export function parseSMF(buf: Buffer): ParsedSMF {
  const r = new Reader(buf);
  if (buf.length < 14 || r.bytes(4).toString("latin1") !== "MThd") {
    throw new GBError("INVALID_INPUT", "Not a Standard MIDI File (missing MThd header).");
  }
  const headLen = r.u32();
  const format = r.u16();
  const ntrks = r.u16();
  const division = r.u16();
  r.pos += headLen - 6;
  if (format > 1) {
    throw new GBError("INVALID_INPUT", `SMF format ${format} (sequential tracks) is not supported — formats 0 and 1 only.`);
  }
  if (division & 0x8000) {
    throw new GBError("INVALID_INPUT", "SMPTE time division is not supported — PPQ files only.");
  }

  const tracks: ParsedTrack[] = [];
  const tempos: Array<{ tick: number; bpm: number }> = [];

  for (let t = 0; t < ntrks && !r.eof; t++) {
    if (r.bytes(4).toString("latin1") !== "MTrk") {
      throw new GBError("INVALID_INPUT", `Malformed SMF: track ${t} chunk header missing.`);
    }
    const len = r.u32();
    const end = r.pos + len;
    const track: ParsedTrack = { name: null, notes: [] };
    const open = new Map<string, { tick: number; velocity: number }>();
    let tick = 0;
    let running = 0;

    while (r.pos < end) {
      tick += r.varlen();
      let status = r.u8();
      if (status < 0x80) {
        // running status: this byte is data
        r.pos--;
        status = running;
      } else if (status < 0xf0) {
        running = status;
      }

      if (status === 0xff) {
        const type = r.u8();
        const mlen = r.varlen();
        const data = r.bytes(mlen);
        if (type === 0x51 && mlen === 3) {
          const usPerQuarter = (data[0] << 16) | (data[1] << 8) | data[2];
          if (usPerQuarter > 0) tempos.push({ tick, bpm: 60_000_000 / usPerQuarter });
        } else if (type === 0x03 && track.name === null) {
          track.name = data.toString("utf8").replace(/\0/g, "").trim() || null;
        }
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        r.pos += r.varlen();
        continue;
      }

      const kind = status & 0xf0;
      const channel = status & 0x0f;
      if (kind === 0x90 || kind === 0x80) {
        const note = r.u8();
        const velocity = r.u8();
        const key = `${channel}:${note}`;
        if (kind === 0x90 && velocity > 0) {
          if (!open.has(key)) open.set(key, { tick, velocity });
        } else {
          const o = open.get(key);
          if (o) {
            open.delete(key);
            track.notes.push({
              tick: o.tick,
              durTicks: Math.max(1, tick - o.tick),
              note,
              velocity: o.velocity,
              channel,
            });
          }
        }
      } else if (kind === 0xc0 || kind === 0xd0) {
        r.pos += 1;
      } else {
        r.pos += 2; // aftertouch, CC, pitch bend — 2 data bytes
      }
    }
    // close anything left hanging at track end
    for (const [key, o] of open) {
      const [channel, note] = key.split(":").map(Number);
      track.notes.push({ tick: o.tick, durTicks: division, note, velocity: o.velocity, channel });
    }
    r.pos = end;
    tracks.push(track);
  }

  tempos.sort((a, b) => a.tick - b.tick);
  return { division, tracks, tempos };
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Convert a parsed SMF into the server's song format (layers + tempo map). */
export function toSong(parsed: ParsedSMF, maxNotes = 4000): ImportedSong {
  const ppq = parsed.division;
  const tempo = parsed.tempos.length > 0 ? Math.round(parsed.tempos[0].bpm * 100) / 100 : 120;
  const tempoMap: TempoPoint[] = parsed.tempos
    .slice(1, 51)
    .map((t) => ({ beat: round3(t.tick / ppq), bpm: Math.round(t.bpm * 100) / 100 }))
    .filter((t, i, arr) => i === 0 || t.bpm !== arr[i - 1].bpm);

  const allNotes = parsed.tracks.flatMap((t) => t.notes);
  allNotes.sort((a, b) => a.tick - b.tick);
  const truncated = allNotes.length > maxNotes;
  const cutoffTick = truncated ? allNotes[maxNotes - 1].tick : Infinity;

  const layers: SongLayer[] = [];
  let totalNotes = 0;
  let lengthBeats = 0;
  parsed.tracks.forEach((t, i) => {
    const notes = t.notes.filter((n) => n.tick <= cutoffTick);
    if (notes.length === 0) return;
    const chCounts = new Map<number, number>();
    for (const n of notes) chCounts.set(n.channel, (chCounts.get(n.channel) ?? 0) + 1);
    const mainCh = [...chCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const events: SequenceEvent[] = notes.map((n) => ({
      note: n.note,
      startBeat: round3(n.tick / ppq),
      durationBeats: Math.max(0.05, round3(n.durTicks / ppq)),
      velocity: Math.max(1, Math.min(127, n.velocity)),
      channel: n.channel + 1,
    }));
    for (const e of events) lengthBeats = Math.max(lengthBeats, e.startBeat + e.durationBeats);
    totalNotes += events.length;
    layers.push({
      name: t.name ?? (mainCh === 9 ? `track ${i + 1} (drums)` : `track ${i + 1}`),
      channel: mainCh + 1,
      events,
    });
  });

  return { tempo, tempoMap, layers, totalNotes, lengthBeats: round3(lengthBeats), truncated };
}
