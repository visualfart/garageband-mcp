import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ok, guarded, GBError } from "../errors.js";
import { parseSMF, toSong, type ImportedSong } from "../smf.js";
import { mergeLayers, sequenceLengthBeats } from "../music.js";
import { playEvents, recordSequenceFlow } from "./compose.js";

const MIDI_MAX_BYTES = 5 * 1024 * 1024;
const AUDIO_MAX_BYTES = 30 * 1024 * 1024;
const SAMPLES_DIR = join(homedir(), "Music", "GarageBand MCP Samples");

let lastImport: { source: string; song: ImportedSong } | null = null;

async function fetchBytes(url: string, maxBytes: number): Promise<Buffer> {
  if (!/^https:\/\//.test(url)) {
    throw new GBError("INVALID_INPUT", "Only https:// URLs are allowed.");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) {
      throw new GBError("INVALID_INPUT", `Download failed: HTTP ${res.status} for ${url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new GBError("INVALID_INPUT", `File is ${(buf.length / 1e6).toFixed(1)} MB — over the ${maxBytes / 1e6} MB limit.`);
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

function requireImport(): { source: string; song: ImportedSong } {
  if (!lastImport) {
    throw new GBError("INVALID_INPUT", "No MIDI file has been imported yet.", "Run gb_import_midi first.");
  }
  return lastImport;
}

function pickLayer(song: ImportedSong, layer: number) {
  if (layer < 1 || layer > song.layers.length) {
    throw new GBError(
      "INVALID_INPUT",
      `Layer ${layer} does not exist — the import has ${song.layers.length} layers.`,
      "gb_import_midi's summary lists them.",
    );
  }
  return song.layers[layer - 1];
}

function summarize(source: string, song: ImportedSong): string {
  const lines = [
    `Imported: ${source}`,
    `Tempo: ${song.tempo} BPM${song.tempoMap.length ? ` with ${song.tempoMap.length} tempo changes` : ""} · ${song.totalNotes} notes · ${song.lengthBeats} beats (~${Math.ceil(song.lengthBeats / 4)} bars)` +
      (song.truncated ? " · TRUNCATED to the note cap" : ""),
    "Layers:",
    ...song.layers.map(
      (l, i) => `  ${i + 1}. ${l.name} — ${l.events.length} notes (midi ch ${l.channel})`,
    ),
    "",
    "Next: gb_play_imported to audition (all layers or one), gb_record_imported {layer: N} per layer to record into GarageBand — set the project tempo to match first (gb_set_tempo). gb_imported_events returns the raw events if you want to edit them.",
  ];
  return lines.join("\n");
}

export function registerImportTools(server: McpServer): void {
  server.registerTool(
    "gb_import_midi",
    {
      title: "Import a MIDI file",
      description:
        "Download (https) or read a local Standard MIDI File and convert it into playable layers — notes, velocities, tempo and tempo changes all preserved. Use OPEN sources only: Mutopia Project (public domain scores), piano-midi.de (CC classical performances), Wikimedia Commons — not transcriptions of copyrighted songs. The import is held in memory for gb_play_imported / gb_record_imported / gb_imported_events.",
      inputSchema: {
        url: z.string().optional().describe("https URL of a .mid file from an open-licensed source"),
        path: z.string().optional().describe("Absolute local path to a .mid file (alternative to url)"),
        maxNotes: z.number().int().min(100).max(20000).optional().describe("Note cap, default 4000"),
      },
    },
    async ({ url, path, maxNotes }) =>
      guarded(async () => {
        if (!url && !path) {
          throw new GBError("INVALID_INPUT", "Pass a `url` or a local `path`.");
        }
        const buf = url ? await fetchBytes(url, MIDI_MAX_BYTES) : await readFile(path!);
        const song = toSong(parseSMF(buf), maxNotes ?? 4000);
        if (song.layers.length === 0) {
          throw new GBError("INVALID_INPUT", "The MIDI file parsed but contains no notes.");
        }
        const source = url ?? path!;
        lastImport = { source, song };
        return ok(summarize(source, song));
      }),
  );

  server.registerTool(
    "gb_imported_events",
    {
      title: "Get imported events",
      description:
        "Return the raw sequence events of one layer of the last MIDI import as JSON — to inspect, trim, transpose, or hand-edit before recording. Large layers are paginated.",
      inputSchema: {
        layer: z.number().int().min(1),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional().describe("Default 200 events"),
      },
    },
    async ({ layer, offset, limit }) =>
      guarded(async () => {
        const { song } = requireImport();
        const l = pickLayer(song, layer);
        const start = offset ?? 0;
        const slice = l.events.slice(start, start + (limit ?? 200));
        return ok(
          `Layer ${layer} "${l.name}" events ${start}-${start + slice.length} of ${l.events.length} (tempo ${song.tempo}):\n` +
            JSON.stringify(slice),
        );
      }),
  );

  server.registerTool(
    "gb_play_imported",
    {
      title: "Play imported MIDI",
      description:
        "Audition the last MIDI import live through the selected GarageBand track — the whole piece (layers merged) or one layer. No recording.",
      inputSchema: {
        layer: z.number().int().min(1).optional().describe("Just this layer; omit for all layers merged"),
      },
    },
    async ({ layer }) =>
      guarded(async () => {
        const { source, song } = requireImport();
        const events = layer !== undefined ? pickLayer(song, layer).events : mergeLayers(song.layers);
        const n = await playEvents(events, song.tempo, song.tempoMap);
        return ok(
          `Played ${n} notes of ${source}${layer !== undefined ? ` (layer ${layer})` : ` (${song.layers.length} layers merged)`} over ${sequenceLengthBeats(events).toFixed(1)} beats.`,
        );
      }),
  );

  server.registerTool(
    "gb_record_imported",
    {
      title: "Record imported MIDI layer",
      description:
        "Record one layer of the last MIDI import onto the selected GarageBand track (same verified flow as gb_record_sequence). Set the project tempo to the import's tempo first (the import summary shows it), pick the track and instrument, then record layer by layer.",
      inputSchema: {
        layer: z.number().int().min(1),
        countInBars: z.number().int().min(0).max(4).optional(),
        beatsPerBar: z.number().int().min(1).max(12).optional(),
        startLatencyMs: z.number().int().min(0).max(2000).optional(),
      },
    },
    async ({ layer, countInBars, beatsPerBar, startLatencyMs }) =>
      guarded(async () => {
        const { song } = requireImport();
        const l = pickLayer(song, layer);
        const summary = await recordSequenceFlow(l.events, {
          tempo: song.tempo,
          tempoMap: song.tempoMap,
          countInBars,
          beatsPerBar,
          startLatencyMs,
        });
        return ok(`Layer ${layer} "${l.name}": ${summary}`);
      }),
  );

  server.registerTool(
    "gb_search_freesound",
    {
      title: "Search Freesound samples",
      description:
        "Search Freesound.org — the open audio sample library (hundreds of thousands of CC-licensed sounds: drum hits, loops, FX, field recordings). Requires a free API key in the FREESOUND_API_KEY env var (get one at https://freesound.org/apiv2/apply — set it in the MCP server config's env block). Defaults to CC0 (no attribution needed).",
      inputSchema: {
        query: z.string().min(2),
        license: z
          .enum(["cc0", "attribution", "any"])
          .optional()
          .describe("cc0 = public-domain-like (default); attribution = CC-BY (credit the author); any"),
        maxResults: z.number().int().min(1).max(30).optional(),
      },
    },
    async ({ query, license, maxResults }) =>
      guarded(async () => {
        const token = process.env.FREESOUND_API_KEY;
        if (!token) {
          throw new GBError(
            "INVALID_INPUT",
            "FREESOUND_API_KEY is not set.",
            'Get a free key at https://freesound.org/apiv2/apply, then add it to the server\'s env — e.g. in the MCP config: "env": {"FREESOUND_API_KEY": "..."} — and restart the server.',
          );
        }
        const lic = license ?? "cc0";
        const filter =
          lic === "cc0" ? '&filter=license:"Creative Commons 0"' : lic === "attribution" ? '&filter=license:"Attribution"' : "";
        const url =
          `https://freesound.org/apiv2/search/text/?query=${encodeURIComponent(query)}${filter}` +
          `&fields=id,name,duration,license,username&page_size=${maxResults ?? 10}&token=${token}`;
        const res = await fetch(url);
        if (!res.ok) {
          throw new GBError("INVALID_INPUT", `Freesound API error: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
        }
        const data = (await res.json()) as {
          count: number;
          results: Array<{ id: number; name: string; duration: number; license: string; username: string }>;
        };
        if (data.results.length === 0) return ok(`No Freesound results for "${query}" with license=${lic}.`);
        return ok(
          `Freesound results for "${query}" (${data.count} total):\n` +
            data.results
              .map((r) => `- id ${r.id}: "${r.name}" · ${r.duration.toFixed(1)}s · by ${r.username} · ${r.license}`)
              .join("\n") +
            "\n\nDownload with gb_download_sample {id}. For CC-BY sounds, credit the author wherever the music is shared.",
        );
      }),
  );

  server.registerTool(
    "gb_download_sample",
    {
      title: "Download a Freesound sample",
      description:
        "Download a Freesound sound's high-quality MP3 preview into ~/Music/GarageBand MCP Samples/. GarageBand can't be scripted to import audio, so finish by dragging the file from Finder into the GarageBand tracks area (it lands as an audio region). Reports the license and required attribution.",
      inputSchema: {
        id: z.number().int().min(1).describe("Sound id from gb_search_freesound"),
      },
    },
    async ({ id }) =>
      guarded(async () => {
        const token = process.env.FREESOUND_API_KEY;
        if (!token) {
          throw new GBError("INVALID_INPUT", "FREESOUND_API_KEY is not set.", "See gb_search_freesound for setup.");
        }
        const res = await fetch(`https://freesound.org/apiv2/sounds/${id}/?fields=name,previews,license,username&token=${token}`);
        if (!res.ok) {
          throw new GBError("INVALID_INPUT", `Freesound API error: HTTP ${res.status}`);
        }
        const info = (await res.json()) as {
          name: string;
          previews: Record<string, string>;
          license: string;
          username: string;
        };
        const previewUrl = info.previews["preview-hq-mp3"] ?? Object.values(info.previews)[0];
        if (!previewUrl) {
          throw new GBError("INVALID_INPUT", `Sound ${id} has no downloadable preview.`);
        }
        const audio = await fetchBytes(previewUrl, AUDIO_MAX_BYTES);
        await mkdir(SAMPLES_DIR, { recursive: true });
        const safe = info.name.replace(/[^\w.-]+/g, "_").slice(0, 60);
        const dest = join(SAMPLES_DIR, `${id}-${safe}.mp3`);
        await writeFile(dest, audio);
        return ok(
          `Saved: ${dest} (${(audio.length / 1024).toFixed(0)} KB)\n` +
            `License: ${info.license} · by ${info.username}` +
            (/Attribution/i.test(info.license) ? ` — CREDIT REQUIRED: "${info.name}" by ${info.username} (freesound.org)` : "") +
            "\n\nTo use it: drag this file from Finder into GarageBand's tracks area — it becomes an audio region on a new track.",
        );
      }),
  );
}
