#!/usr/bin/env node
// Renders a waveform SVG for every MP3 in examples/audio/ — used as clickable
// visual previews in the READMEs (GitHub can't embed audio players, but a
// waveform image linking to the MP3's blob page gets one click away).
// Requires ffmpeg. Run after render-previews.mjs.
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const AUDIO = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "audio");
const OUT = join(AUDIO, "waves");
mkdirSync(OUT, { recursive: true });

const W = 480, H = 56, BARS = 120;

for (const f of readdirSync(AUDIO).filter((f) => f.endsWith(".mp3"))) {
  const raw = execFileSync("ffmpeg", ["-loglevel", "error", "-i", join(AUDIO, f), "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const samples = raw.length >> 1;
  const per = Math.max(1, Math.floor(samples / BARS));
  const peaks = [];
  let max = 0;
  for (let b = 0; b < BARS; b++) {
    let peak = 0;
    for (let i = b * per; i < Math.min(samples, (b + 1) * per); i++) {
      const v = Math.abs(raw.readInt16LE(i * 2));
      if (v > peak) peak = v;
    }
    peaks.push(peak);
    if (peak > max) max = peak;
  }
  const bw = W / BARS;
  const bars = peaks
    .map((p, i) => {
      const h = Math.max(2, (p / (max || 1)) * (H - 4));
      const x = (i * bw + 1).toFixed(1);
      const y = ((H - h) / 2).toFixed(1);
      return `<rect x="${x}" y="${y}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1"/>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><g fill="#8a8f98">${bars}</g></svg>\n`;
  writeFileSync(join(OUT, basename(f, ".mp3") + ".svg"), svg);
  console.log(`${basename(f, ".mp3")}.svg`);
}
