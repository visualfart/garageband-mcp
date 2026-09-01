import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, guarded, GBError } from "../errors.js";
import * as ui from "../ui.js";
import { runJXA } from "../osa.js";

/**
 * The tempo control in GarageBand's LCD is an AXSlider (description "Tempo")
 * inside the Control Bar group — readable AND settable directly through
 * accessibility, no clicking or typing needed. BFS is rooted at the Control
 * Bar (a few dozen nodes) with a window-wide fallback.
 */
function tempoScript(op: "get" | "set", bpm?: number): string {
  return `
    const se = Application('System Events');
    const p = se.processes['GarageBand'];
    const w = p.windows[0];
    let roots = [];
    try {
      const cbs = w.uiElements.whose({description: 'Control Bar'});
      if (cbs.length > 0) roots.push(cbs[0]);
    } catch (e) {}
    roots.push(w);
    let tempoEl = null;
    for (const root of roots) {
      const queue = [root];
      let visited = 0;
      while (queue.length > 0 && visited < 400 && tempoEl === null) {
        const el = queue.shift();
        visited++;
        try {
          if (String(el.role()) === 'AXSlider' && /tempo/i.test(String(el.description()))) {
            tempoEl = el;
            break;
          }
        } catch (e) {}
        try {
          const kids = el.uiElements();
          for (let i = 0; i < kids.length; i++) queue.push(kids[i]);
        } catch (e) {}
      }
      if (tempoEl !== null) break;
    }
    if (tempoEl === null) {
      'NOTFOUND';
    } else {
      ${op === "set" ? `tempoEl.value = ${bpm}; delay(0.3);` : ""}
      String(tempoEl.value());
    }
  `;
}

export function registerTempoTools(server: McpServer): void {
  server.registerTool(
    "gb_get_tempo",
    {
      title: "Get project tempo",
      description: "Read the project tempo from the LCD's tempo slider via accessibility.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        const out = await runJXA(tempoScript("get"), 30_000);
        if (out === "NOTFOUND") {
          throw new GBError(
            "ELEMENT_NOT_FOUND",
            "Could not find the tempo control in the LCD.",
            "Make sure the LCD (top center) shows tempo — set it to 'Beats & Project' mode.",
          );
        }
        return ok(`Project tempo: ${Math.round(parseFloat(out))} BPM`);
      }),
  );

  server.registerTool(
    "gb_set_tempo",
    {
      title: "Set project tempo",
      description:
        "Set the project tempo by writing the LCD tempo slider's accessibility value. Verified by reading back.",
      inputSchema: {
        bpm: z.number().int().min(40).max(240),
      },
    },
    async ({ bpm }) =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        const out = await runJXA(tempoScript("set", bpm), 30_000);
        if (out === "NOTFOUND") {
          throw new GBError(
            "ELEMENT_NOT_FOUND",
            "Could not find the tempo control in the LCD.",
            "Make sure the LCD (top center) shows tempo — set it to 'Beats & Project' mode.",
          );
        }
        const readback = Math.round(parseFloat(out));
        if (readback === bpm) return ok(`Tempo set to ${bpm} BPM (verified).`);
        return ok(
          `Tempo write sent (target ${bpm} BPM) but readback shows ${readback} BPM. Check the LCD with gb_screenshot, or set it manually.`,
        );
      }),
  );
}
