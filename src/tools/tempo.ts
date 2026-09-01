import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, guarded, GBError } from "../errors.js";
import * as ui from "../ui.js";
import { runJXA, sleep } from "../osa.js";

interface AxHit {
  desc: string;
  value: string | null;
  role: string;
  pos: [number, number] | null;
  size: [number, number] | null;
}

/**
 * BFS the front window's accessibility tree for elements whose AXDescription
 * mentions "tempo" (the LCD tempo readout). Node-capped: AX calls are Apple
 * Events and each one costs a round trip.
 */
async function findTempoElements(): Promise<AxHit[]> {
  const script = `
    const se = Application('System Events');
    const p = se.processes['GarageBand'];
    const found = [];
    const queue = [];
    try { queue.push(p.windows[0]); } catch (e) {}
    let visited = 0;
    while (queue.length > 0 && visited < 400) {
      const el = queue.shift();
      visited++;
      let desc = '';
      try { desc = String(el.description() || ''); } catch (e) {}
      if (/tempo/i.test(desc)) {
        const hit = { desc: desc, value: null, role: '', pos: null, size: null };
        try { const v = el.value(); if (v !== null && v !== undefined) hit.value = String(v); } catch (e) {}
        try { hit.role = String(el.role()); } catch (e) {}
        try { hit.pos = el.position(); } catch (e) {}
        try { hit.size = el.size(); } catch (e) {}
        found.push(hit);
      }
      try {
        const kids = el.uiElements();
        for (let i = 0; i < kids.length; i++) queue.push(kids[i]);
      } catch (e) {}
    }
    JSON.stringify(found);
  `;
  const out = await runJXA(script, 30_000);
  return JSON.parse(out) as AxHit[];
}

function bestTempoHit(hits: AxHit[]): AxHit | undefined {
  // prefer an element that actually carries a numeric value
  return hits.find((h) => h.value !== null && /\d/.test(h.value)) ?? hits[0];
}

export function registerTempoTools(server: McpServer): void {
  server.registerTool(
    "gb_get_tempo",
    {
      title: "Get project tempo",
      description:
        "Read the project tempo from GarageBand's LCD display via accessibility. The LCD must be in a mode that shows tempo (Beats & Project — the default).",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        const hits = await findTempoElements();
        const hit = bestTempoHit(hits);
        if (!hit || hit.value === null) {
          throw new GBError(
            "ELEMENT_NOT_FOUND",
            "Could not find a tempo readout in the LCD.",
            "Make sure the LCD (top center) is set to 'Beats & Project' mode, which shows the tempo.",
          );
        }
        const m = hit.value.match(/[\d.]+/);
        return ok(`Project tempo: ${m ? m[0] : hit.value} BPM`);
      }),
  );

  server.registerTool(
    "gb_set_tempo",
    {
      title: "Set project tempo",
      description:
        "Set the project tempo by editing the LCD tempo field (double-click, type, Return). The least reliable tool here — verify with gb_get_tempo afterward.",
      inputSchema: {
        bpm: z.number().int().min(40).max(240),
      },
    },
    async ({ bpm }) =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        const hits = await findTempoElements();
        const hit = bestTempoHit(hits);
        if (!hit || !hit.pos || !hit.size) {
          throw new GBError(
            "ELEMENT_NOT_FOUND",
            "Could not locate the tempo element in the LCD to click it.",
            "Set the LCD to 'Beats & Project' mode, or change the tempo manually in GarageBand.",
          );
        }
        const cx = Math.round(hit.pos[0] + hit.size[0] / 2);
        const cy = Math.round(hit.pos[1] + hit.size[1] / 2);
        await ui.doubleClickAt(cx, cy);
        await sleep(400);
        await ui.keystroke(String(bpm));
        await sleep(150);
        await ui.keyCode(ui.KEY.RETURN);
        await sleep(400);
        // verify by re-reading
        const after = bestTempoHit(await findTempoElements());
        const readback = after?.value?.match(/[\d.]+/)?.[0];
        if (readback && Math.round(parseFloat(readback)) === bpm) {
          return ok(`Tempo set to ${bpm} BPM (verified).`);
        }
        return ok(
          `Tempo edit sent (target ${bpm} BPM) but readback ${readback ? `shows ${readback}` : "failed"}. ` +
            "Check the LCD or take a gb_screenshot; if it didn't take, set the tempo manually in GarageBand.",
        );
      }),
  );
}
