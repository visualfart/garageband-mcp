import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, guarded, GBError } from "../errors.js";
import * as ui from "../ui.js";
import { sleep } from "../osa.js";

export function registerTrackTools(server: McpServer): void {
  server.registerTool(
    "gb_add_software_instrument_track",
    {
      title: "Add software instrument track",
      description:
        "Add a new software-instrument track (the kind that receives MIDI from this server). Uses Cmd+Opt+S; if a track-type dialog appears, accepts the default.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        await ui.keystroke("s", ["command", "option"]);
        await sleep(1200);
        const sheet = await ui.frontSheet();
        if (sheet.present) {
          await ui.keyCode(ui.KEY.RETURN);
          await sleep(1000);
        }
        return ok(
          "Software-instrument track added and selected. It is the MIDI recording target; pick its sound in GarageBand's library, or just play into it with gb_play_note / gb_record_sequence.",
        );
      }),
  );

  server.registerTool(
    "gb_delete_selected_track",
    {
      title: "Delete selected track",
      description: "Delete the currently selected track (Cmd+Delete). Destructive — requires confirm: true.",
      inputSchema: {
        confirm: z.boolean().describe("Must be true to delete"),
      },
    },
    async ({ confirm }) =>
      guarded(async () => {
        if (!confirm) {
          throw new GBError("INVALID_INPUT", "Pass confirm: true to delete the selected track.");
        }
        await ui.ensureReady({ needsProject: true });
        await ui.keyCode(ui.KEY.DELETE, ["command"]);
        return ok("Selected track deleted (undo with Cmd+Z in GarageBand if unintended).");
      }),
  );

  server.registerTool(
    "gb_select_track",
    {
      title: "Select track",
      description:
        'Move track selection with arrow keys: direction "up"/"down", repeated `count` times.',
      inputSchema: {
        direction: z.enum(["up", "down"]).describe("Direction to move the selection"),
        count: z.number().int().min(1).max(32).optional().describe("Steps to move (default 1)"),
      },
    },
    async ({ direction, count }) =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        const code = direction === "up" ? 126 : 125;
        const steps = count ?? 1;
        for (let i = 0; i < steps; i++) {
          await ui.keyCode(code);
          await sleep(120);
        }
        return ok(`Selection moved ${direction} ${steps} track(s).`);
      }),
  );

  server.registerTool(
    "gb_mute_selected_track",
    {
      title: "Mute selected track",
      description: "Toggle mute on the selected track (M).",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        await ui.keystroke("m");
        return ok("Mute toggled on the selected track.");
      }),
  );

  server.registerTool(
    "gb_solo_selected_track",
    {
      title: "Solo selected track",
      description: "Toggle solo on the selected track (S).",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        await ui.keystroke("s");
        return ok("Solo toggled on the selected track.");
      }),
  );
}
