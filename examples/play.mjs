#!/usr/bin/env node
// Standalone demo player — streams an example sequence into GarageBand
// through the MCP server, no AI agent or MCP client required.
//
//   node examples/play.mjs examples/lofi-chords.json            # audition live
//   node examples/play.mjs examples/drum-groove.json --record   # record into the project
//
// GarageBand must be open with a software-instrument track selected.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const file = process.argv[2];
const record = process.argv.includes("--record");
if (!file) {
  console.error("Usage: node examples/play.mjs <sequence.json> [--record]");
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

console.log(`${record ? "Recording" : "Playing"}: ${seq.name} (${seq.tempo} BPM)`);
const res = await call("tools/call", {
  name: record ? "gb_record_sequence" : "gb_play_sequence",
  arguments: { tempo: seq.tempo, events: seq.events },
});
for (const c of res.result?.content ?? []) {
  if (c.type === "text") console.log(c.text);
}
proc.kill();
process.exit(res.result?.isError ? 1 : 0);
