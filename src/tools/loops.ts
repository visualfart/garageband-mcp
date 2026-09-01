import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, guarded, GBError } from "../errors.js";
import * as ui from "../ui.js";
import { sleep } from "../osa.js";
import { scanGroup, type AxHit } from "../ax.js";

// the loop browser's AX group description varies by version — try known names
const LOOP_GROUPS = ["Loop Browser", "Loops", "Apple Loops"];

async function loopScan(matchExpr: string, cap = 60): Promise<{ group: string; hits: AxHit[] } | null> {
  for (const group of LOOP_GROUPS) {
    const hits = await scanGroup(group, matchExpr, cap);
    if (hits !== null) return { group, hits };
  }
  return null;
}

async function ensureLoopBrowser(): Promise<string> {
  let found = await loopScan("role.length > 0", 1);
  if (!found) {
    await ui.keystroke("o"); // toggle loop browser
    await sleep(900);
    found = await loopScan("role.length > 0", 1);
  }
  if (!found) {
    throw new GBError(
      "ELEMENT_NOT_FOUND",
      "Could not find the Apple Loops browser panel after pressing O.",
      "gb_screenshot shows the window — the panel name may differ on this GarageBand version.",
    );
  }
  return found.group;
}

async function findLoopRows(group: string): Promise<AxHit[]> {
  const res = await scanGroup(group, `role === 'AXStaticText' && value.length > 1`, 80);
  return (res ?? []).filter((h) => h.pos && h.size);
}

export function registerLoopTools(server: McpServer): void {
  server.registerTool(
    "gb_search_loops",
    {
      title: "Search Apple Loops",
      description:
        "Open the Apple Loops browser and search it (drum grooves, basslines, melodies, one-shots — royalty-free, included with GarageBand). Returns the matching loop names; use gb_add_loop to pull one into the project. Clicking a result in GarageBand previews it at project tempo.",
      inputSchema: {
        query: z.string().min(2).describe('e.g. "hip hop beat", "funk bass", "strings"'),
      },
    },
    async ({ query }) =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        const group = await ensureLoopBrowser();
        const fields = (await scanGroup(group, `role === 'AXTextField'`, 3)) ?? [];
        const field = fields.find((f) => f.pos && f.size);
        if (!field) {
          throw new GBError(
            "ELEMENT_NOT_FOUND",
            `No search field found in the "${group}" panel.`,
            "gb_screenshot shows the panel layout.",
          );
        }
        await ui.clickAt(field.pos![0] + field.size![0] / 2, field.pos![1] + field.size![1] / 2);
        await sleep(250);
        await ui.keystroke("a", ["command"]);
        await ui.keystroke(query);
        await ui.keyCode(ui.KEY.RETURN);
        await sleep(1200);
        const rows = await findLoopRows(group);
        if (rows.length === 0) return ok(`No loops matched "${query}". Try broader terms.`);
        const names = [...new Set(rows.map((r) => r.text))].slice(0, 30);
        return ok(`Loops matching "${query}":\n` + names.map((n, i) => `${i + 1}. ${n}`).join("\n"));
      }),
  );

  server.registerTool(
    "gb_add_loop",
    {
      title: "Add loop to project",
      description:
        "Drag an Apple Loop from the browser (search first with gb_search_loops) into the empty area below the tracks — GarageBand creates a new track for it near bar 1. Verify placement with gb_screenshot; loops can be repositioned in GarageBand afterwards.",
      inputSchema: {
        name: z.string().min(2).describe("Loop name (or distinctive part) from gb_search_loops results"),
      },
    },
    async ({ name }) =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        const group = await ensureLoopBrowser();
        const rows = await findLoopRows(group);
        const q = name.toLowerCase();
        const row =
          rows.find((r) => r.text.toLowerCase() === q) ??
          rows.find((r) => r.text.toLowerCase().includes(q));
        if (!row) {
          throw new GBError(
            "ELEMENT_NOT_FOUND",
            `No loop row matching "${name}". Visible: ${[...new Set(rows.map((r) => r.text))].slice(0, 20).join(" | ")}`,
            "Run gb_search_loops first so the loop is visible in the results list.",
          );
        }
        // drop target: inside the Tracks area, right of the headers, below the last track
        const tracks = (await scanGroup("Tracks", `role.length > 0`, 1)) ?? [];
        const tracksArea = tracks.find((t) => t.pos && t.size);
        if (!tracksArea) {
          throw new GBError("ELEMENT_NOT_FOUND", "Could not locate the Tracks area for the drop target.");
        }
        const dropX = tracksArea.pos![0] + 260; // past the header column ≈ bar 1
        const dropY = tracksArea.pos![1] + tracksArea.size![1] - 60; // empty lane below tracks
        await ui.dragFromTo(
          row.pos![0] + row.size![0] / 2,
          row.pos![1] + row.size![1] / 2,
          dropX,
          dropY,
        );
        await sleep(1500);
        return ok(
          `Dragged loop "${row.text}" into the tracks area — GarageBand should have created a new track for it near bar 1. Verify with gb_screenshot or gb_list_tracks; undo with gb_undo if it landed wrong.`,
        );
      }),
  );
}
