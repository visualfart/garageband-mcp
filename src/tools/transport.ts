import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, guarded, GBError } from "../errors.js";
import * as ui from "../ui.js";
import { sleep } from "../osa.js";
import { readLcdSlider, writeLcdSlider } from "../lcd.js";

/**
 * Move the playhead to the beginning and VERIFY it via the LCD's position
 * slider — the Return keystroke alone can silently miss (focus quirks), which
 * shifts every subsequent recording rightward on the timeline. Falls back to
 * writing the slider value directly. Returns the final position (null if the
 * LCD slider wasn't found and verification was impossible).
 */
export async function rewindVerified(): Promise<number | null> {
  await ui.keyCode(ui.KEY.RETURN);
  await sleep(300);
  let pos = await readLcdSlider("beat");
  if (pos !== null && pos > 1.01) {
    pos = await writeLcdSlider("beat", 1);
  }
  return pos;
}

export function registerTransportTools(server: McpServer): void {
  const simple: Array<{ name: string; title: string; description: string; act: () => Promise<void>; done: string }> = [
    {
      name: "gb_play",
      title: "Play/pause",
      description: "Toggle playback from the current playhead position (Space).",
      act: () => ui.keyCode(ui.KEY.SPACE),
      done: "Play/pause toggled.",
    },
    {
      name: "gb_stop",
      title: "Stop",
      description: "Stop playback or recording (Space). Same key as play — GarageBand toggles.",
      act: () => ui.keyCode(ui.KEY.SPACE),
      done: "Stop sent.",
    },
    {
      name: "gb_record",
      title: "Record",
      description:
        "Start/stop recording on the selected track (R). For composing, prefer gb_record_sequence which handles timing end-to-end.",
      act: () => ui.keystroke("r"),
      done: "Record toggled.",
    },
    {
      name: "gb_toggle_cycle",
      title: "Toggle cycle",
      description: "Toggle the cycle/loop region (C).",
      act: () => ui.keystroke("c"),
      done: "Cycle region toggled.",
    },
    {
      name: "gb_toggle_metronome",
      title: "Toggle metronome",
      description: "Toggle the metronome click (K).",
      act: () => ui.keystroke("k"),
      done: "Metronome toggled.",
    },
    {
      name: "gb_toggle_count_in",
      title: "Toggle count-in",
      description: "Toggle the 1-bar count-in before recording (Shift+K).",
      act: () => ui.keystroke("k", ["shift"]),
      done: "Count-in toggled.",
    },
    {
      name: "gb_undo",
      title: "Undo",
      description: "Undo the last GarageBand action (Cmd+Z) — a bad take, a wrong loop drop, a deleted track.",
      act: () => ui.keystroke("z", ["command"]),
      done: "Undo sent.",
    },
    {
      name: "gb_redo",
      title: "Redo",
      description: "Redo the last undone GarageBand action (Cmd+Shift+Z).",
      act: () => ui.keystroke("z", ["command", "shift"]),
      done: "Redo sent.",
    },
  ];

  for (const t of simple) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: {} },
      async () =>
        guarded(async () => {
          await ui.ensureReady({ needsProject: true });
          await t.act();
          return ok(t.done);
        }),
    );
  }

  server.registerTool(
    "gb_go_to_beginning",
    {
      title: "Go to beginning",
      description:
        "Move the playhead to the start of the project, verified against the LCD position readout (falls back to setting it directly if the Return keystroke doesn't land).",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        const pos = await rewindVerified();
        if (pos === null) return ok("Rewind sent (LCD position readout not found, could not verify).");
        if (pos > 1.01) {
          throw new GBError(
            "ELEMENT_NOT_FOUND",
            `Playhead still reads position ${pos} after rewinding.`,
            "Check gb_ui_state / gb_screenshot — a dialog or focused field may be swallowing keystrokes.",
          );
        }
        return ok("Playhead at the beginning (verified).");
      }),
  );

  server.registerTool(
    "gb_set_playhead",
    {
      title: "Set playhead position",
      description:
        "Move the playhead to a bar by writing the LCD position slider — e.g. to record a layer starting at a later section. Verified by reading back.",
      inputSchema: {
        bar: z.number().int().min(1).max(9999).describe("Bar number (1 = project start)"),
      },
    },
    async ({ bar }) =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        const pos = await writeLcdSlider("beat", bar);
        if (pos === null) {
          throw new GBError(
            "ELEMENT_NOT_FOUND",
            "Could not find the LCD position readout.",
            "Set the LCD to 'Beats & Project' mode.",
          );
        }
        return ok(`Playhead at bar ${Math.round(pos)}${Math.round(pos) === bar ? " (verified)" : ` — expected ${bar}, check the LCD`}.`);
      }),
  );
}
