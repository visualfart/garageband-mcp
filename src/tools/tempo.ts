import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, guarded, GBError } from "../errors.js";
import * as ui from "../ui.js";
import { readLcdSlider, writeLcdSlider } from "../lcd.js";

const NOT_FOUND = new GBError(
  "ELEMENT_NOT_FOUND",
  "Could not find the tempo control in the LCD.",
  "Make sure the LCD (top center) shows tempo — set it to 'Beats & Project' mode.",
);

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
        const bpm = await readLcdSlider("tempo");
        if (bpm === null) throw NOT_FOUND;
        return ok(`Project tempo: ${Math.round(bpm)} BPM`);
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
        const readback = await writeLcdSlider("tempo", bpm);
        if (readback === null) throw NOT_FOUND;
        if (Math.round(readback) === bpm) return ok(`Tempo set to ${bpm} BPM (verified).`);
        return ok(
          `Tempo write sent (target ${bpm} BPM) but readback shows ${Math.round(readback)} BPM. Check the LCD with gb_screenshot, or set it manually.`,
        );
      }),
  );
}
