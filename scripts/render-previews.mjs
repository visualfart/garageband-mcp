#!/usr/bin/env node
// Renders the example sequences to MP3 previews in examples/audio/ using a
// tiny offline synth — so listeners can hear the arrangements without
// GarageBand. Requires ffmpeg (or lame) on PATH for MP3 encoding; without an
// encoder it leaves WAV files. Run `npm run build` first (imports dist/music.js).
//
//   node scripts/render-previews.mjs
import { readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseNote, makeBeatClock, mergeLayers } from "../dist/music.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = join(ROOT, "examples");
const OUT = join(EXAMPLES, "audio");
const SR = 44100;

mkdirSync(OUT, { recursive: true });

function hasBin(bin) {
  try {
    execFileSync("which", [bin], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
const encoder = hasBin("ffmpeg") ? "ffmpeg" : hasBin("lame") ? "lame" : null;

// ---- voices -----------------------------------------------------------------
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function renderMelodic(buf, t0, t1, midi, amp, kind) {
  const f = midiHz(midi);
  const cfg = {
    pad: { attack: 0.12, release: 0.45, gain: 0.5 },
    strings: { attack: 0.2, release: 0.6, gain: 0.55 },
    lead: { attack: 0.006, release: 0.18, gain: 0.6 },
    bass: { attack: 0.006, release: 0.08, gain: 0.9 },
    fx: { attack: 0.004, release: 0.1, gain: 0.45 },
  }[kind];
  const start = Math.floor(t0 * SR);
  const end = Math.min(buf.length - 1, Math.floor((t1 + cfg.release) * SR));
  const detune = kind === "pad" || kind === "strings" ? 0.004 : 0;
  for (let i = start; i < end; i++) {
    const t = i / SR - t0;
    const env =
      Math.min(1, t / cfg.attack) *
      (i / SR < t1 ? 1 : Math.max(0, 1 - (i / SR - t1) / cfg.release));
    if (env <= 0) continue;
    let s = 0;
    if (kind === "bass") {
      s = Math.sin(2 * Math.PI * f * t) * 0.8 + sawtooth(f, t) * 0.35;
    } else if (kind === "lead" || kind === "fx") {
      s = sawtooth(f, t) * 0.6 + square(f, t) * 0.25;
    } else {
      s = sawtooth(f * (1 + detune), t) * 0.4 + sawtooth(f * (1 - detune), t) * 0.4 + Math.sin(2 * Math.PI * (f / 2) * t) * 0.2;
    }
    buf[i] += s * env * amp * cfg.gain;
  }
}

const sawtooth = (f, t) => 2 * ((f * t) % 1) - 1;
const square = (f, t) => ((f * t) % 1 < 0.5 ? 1 : -1);

let noiseSeed = 22222;
function noise() {
  noiseSeed = (noiseSeed * 1103515245 + 12345) & 0x7fffffff;
  return noiseSeed / 0x3fffffff - 1;
}

function renderDrum(buf, t0, midi, amp) {
  const start = Math.floor(t0 * SR);
  const add = (dur, fn) => {
    const end = Math.min(buf.length - 1, start + Math.floor(dur * SR));
    let prevN = 0,
      hp = 0;
    for (let i = start; i < end; i++) {
      const t = (i - start) / SR;
      buf[i] += fn(t, () => {
        // one-pole highpassed noise for cymbals/hats
        const n = noise();
        hp = 0.86 * (hp + n - prevN);
        prevN = n;
        return hp;
      });
    }
  };
  const exp = (t, tau) => Math.exp(-t / tau);
  switch (midi) {
    case 36: // kick
      add(0.4, (t) => Math.sin(2 * Math.PI * (45 + 110 * exp(t, 0.045)) * t) * exp(t, 0.11) * amp * 1.25);
      break;
    case 38: // snare
      add(0.22, (t, hpn) => (hpn() * 0.7 + Math.sin(2 * Math.PI * 190 * t) * 0.4 * exp(t, 0.04)) * exp(t, 0.055) * amp * 0.9);
      break;
    case 39: // clap: three quick bursts
      add(0.25, (t, hpn) => {
        const burst = exp(t % 0.012, 0.006) * (t < 0.036 ? 1 : 0) + (t >= 0.036 ? exp(t - 0.036, 0.055) : 0);
        return hpn() * burst * amp * 0.85;
      });
      break;
    case 42: // closed hat
    case 44:
      add(0.06, (t, hpn) => hpn() * exp(t, 0.014) * amp * 0.6);
      break;
    case 46: // open hat
      add(0.4, (t, hpn) => hpn() * exp(t, 0.09) * amp * 0.55);
      break;
    case 49: // crash
      add(1.6, (t, hpn) => hpn() * exp(t, 0.45) * amp * 0.65);
      break;
    case 51: // ride
      add(0.8, (t, hpn) => hpn() * exp(t, 0.25) * amp * 0.4);
      break;
    default: {
      // toms / timpani-ish: pitched sine sweep by note
      const base = 70 + (midi - 36) * 8;
      add(0.5, (t) => Math.sin(2 * Math.PI * (base + base * 0.6 * exp(t, 0.06)) * t) * exp(t, 0.16) * amp * 1.0);
    }
  }
}

// ---- rendering --------------------------------------------------------------
function kindForLayer(name = "") {
  if (/drum|perc|beat/i.test(name)) return "drums";
  if (/bass/i.test(name)) return "bass";
  if (/lead|melody|arp/i.test(name)) return "lead";
  if (/fx|riser|fall/i.test(name)) return "fx";
  if (/string|pad|chord|key/i.test(name)) return "strings";
  return "pad";
}

function renderFile(file) {
  const spec = JSON.parse(readFileSync(join(EXAMPLES, file), "utf8"));
  const clock = makeBeatClock(spec.tempo ?? 120, spec.tempoMap ?? []);
  const parts = spec.layers
    ? spec.layers.map((l) => ({ kind: kindForLayer(l.name), events: mergeLayers([l]) }))
    : [{ kind: kindForLayer(basename(file, ".json")), events: spec.events }];

  let lenSec = 0;
  for (const p of parts)
    for (const e of p.events) lenSec = Math.max(lenSec, clock(e.startBeat + e.durationBeats) / 1000);
  const buf = new Float64Array(Math.ceil((lenSec + 2.5) * SR));

  for (const p of parts) {
    for (const e of p.events) {
      const notes = e.notes ?? [e.note];
      const amp = Math.pow((e.velocity ?? 100) / 127, 1.5);
      const t0 = clock(e.startBeat) / 1000;
      const t1 = clock(e.startBeat + e.durationBeats) / 1000;
      for (const n of notes) {
        const midi = parseNote(n);
        if (p.kind === "drums") renderDrum(buf, t0, midi, amp);
        else renderMelodic(buf, t0, t1, midi, amp, p.kind === "strings" ? "strings" : p.kind);
      }
    }
  }

  // soft clip + normalize
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    buf[i] = Math.tanh(buf[i] * 0.8);
    peak = Math.max(peak, Math.abs(buf[i]));
  }
  const norm = peak > 0 ? 0.89 / peak : 1;

  const pcm = Buffer.alloc(44 + buf.length * 2);
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + buf.length * 2, 4); pcm.write("WAVEfmt ", 8);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(SR, 24); pcm.writeUInt32LE(SR * 2, 28); pcm.writeUInt16LE(2, 32);
  pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(buf.length * 2, 40);
  for (let i = 0; i < buf.length; i++) pcm.writeInt16LE(Math.round(buf[i] * norm * 32767), 44 + i * 2);

  const stem = basename(file, ".json");
  const wav = join(OUT, `${stem}.wav`);
  writeFileSync(wav, pcm);
  if (encoder === "ffmpeg") {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-b:a", "192k", join(OUT, `${stem}.mp3`)]);
    rmSync(wav);
  } else if (encoder === "lame") {
    execFileSync("lame", ["--quiet", "-b", "192", wav, join(OUT, `${stem}.mp3`)]);
    rmSync(wav);
  }
  console.log(`${stem}: ${lenSec.toFixed(1)}s ${encoder ? "→ mp3" : "→ wav (no mp3 encoder found)"}`);
}

for (const f of readdirSync(EXAMPLES).filter((f) => f.endsWith(".json"))) renderFile(f);
