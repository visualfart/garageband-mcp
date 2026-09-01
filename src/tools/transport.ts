import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, guarded } from "../errors.js";
import * as ui from "../ui.js";

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
      name: "gb_go_to_beginning",
      title: "Go to beginning",
      description: "Move the playhead to the start of the project (Return).",
      act: () => ui.keyCode(ui.KEY.RETURN),
      done: "Playhead moved to the beginning.",
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
}
