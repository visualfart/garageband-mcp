#!/usr/bin/env node
// Standalone demo player — streams an example sequence into GarageBand
// through the MCP server, no AI agent or MCP client required.
//
//   node examples/play.mjs examples/lofi-chords.json              # audition live
//   node examples/play.mjs examples/drum-groove.json --record     # record into the project
//   node examples/play.mjs examples/edm-anthem.json               # multi-layer song, full mix
//   node examples/play.mjs examples/edm-anthem.json --layer bass  # just one layer (name or index)
//
// GarageBand must be open with a software-instrument track selected. To build a
// real multi-instrument arrangement, record layer by layer: record one --layer,
// add a track in GarageBand, record the next.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const record = args.includes("--record");
const layerIdx = args.indexOf("--layer");
const layerPick = layerIdx >= 0 ? args[layerIdx + 1] : null;
if (!file) {
  console.error("Usage: node examples/play.mjs <sequence.json> [--record] [--layer <name|index>]");
  process.exit(1);
}
const seq = JSON.parse(readFileSync(file, "utf8"));
const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const proc = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const pending = new Map();
let nextId = 1;

proc.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

await call("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "example-player", version: "0" },
});
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

let toolName;
let toolArgs;
if (seq.layers && layerPick !== null) {
  const layer =
    seq.layers.find((l) => l.name === layerPick) ?? seq.layers[Number(layerPick)];
  if (!layer) {
    console.error(`No layer "${layerPick}". Layers: ${seq.layers.map((l, i) => `${i}:${l.name}`).join(", ")}`);
    process.exit(1);
  }
  toolName = record ? "gb_record_sequence" : "gb_play_sequence";
  toolArgs = { tempo: seq.tempo, tempoMap: seq.tempoMap, events: layer.events };
  console.log(`${record ? "Recording" : "Playing"} layer "${layer.name}" of ${seq.name} (${seq.tempo} BPM)`);
} else if (seq.layers) {
  if (record) {
    console.error("Record one layer at a time: --record --layer <name>, adding a GarageBand track between layers.");
    process.exit(1);
  }
  toolName = "gb_play_song";
  toolArgs = { tempo: seq.tempo, tempoMap: seq.tempoMap, layers: seq.layers };
  console.log(`Playing: ${seq.name} (${seq.tempo} BPM, ${seq.layers.length} layers)`);
} else {
  toolName = record ? "gb_record_sequence" : "gb_play_sequence";
  toolArgs = { tempo: seq.tempo, tempoMap: seq.tempoMap, events: seq.events };
  console.log(`${record ? "Recording" : "Playing"}: ${seq.name} (${seq.tempo} BPM)`);
}
const res = await call("tools/call", { name: toolName, arguments: toolArgs });
for (const c of res.result?.content ?? []) {
  if (c.type === "text") console.log(c.text);
}
proc.kill();
process.exit(res.result?.isError ? 1 : 0);
