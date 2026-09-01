import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, guarded, GBError } from "../errors.js";
import * as ui from "../ui.js";
import { sleep } from "../osa.js";
import { scanGroup, setGroupSlider, type AxHit } from "../ax.js";

/** Per-track mixer sliders live in the track headers; associate by vertical order. */
async function trackSliders(descPattern: string): Promise<AxHit[]> {
  const hits = await scanGroup(
    "Tracks",
    `role === 'AXSlider' && ${JSON.stringify(descPattern)}.length > 0 && new RegExp(${JSON.stringify(descPattern)}, 'i').test(desc)`,
    64,
  );
  if (hits === null) {
    throw new GBError("ELEMENT_NOT_FOUND", "Could not find the Tracks area in the window.");
  }
  return hits.filter((h) => h.pos).sort((a, b) => a.pos![1] - b.pos![1]);
}

export function registerMixTools(server: McpServer): void {
  server.registerTool(
    "gb_set_track_volume",
    {
      title: "Set track volume",
      description:
        "Set a track's volume fader (the slider in its header) via accessibility. Level is 0-100 where ~71 is unity gain (0 dB) — GarageBand's sliders are normalized 0-1 under the hood.",
      inputSchema: {
        trackIndex: z.number().int().min(1).max(64).describe("Track number from the top"),
        level: z.number().min(0).max(100).describe("0 = silent, ~71 = 0 dB, 100 = max"),
      },
    },
    async ({ trackIndex, level }) =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        const sliders = await trackSliders("volume");
        if (trackIndex > sliders.length) {
          throw new GBError(
            "ELEMENT_NOT_FOUND",
            `Found ${sliders.length} volume sliders but trackIndex is ${trackIndex}.`,
            "Track headers may be collapsed — enlarge track height in GarageBand, or check gb_list_tracks.",
          );
        }
        const out = await setSliderAt(sliders[trackIndex - 1], level / 100);
        return ok(`Track ${trackIndex} volume set to ${level}${out !== null ? ` (readback ${(out * 100).toFixed(0)})` : ""}.`);
      }),
  );

  server.registerTool(
    "gb_set_track_pan",
    {
      title: "Set track pan",
      description: "Set a track's pan knob via accessibility: -100 = hard left, 0 = center, 100 = hard right.",
      inputSchema: {
        trackIndex: z.number().int().min(1).max(64),
        pan: z.number().min(-100).max(100),
      },
    },
    async ({ trackIndex, pan }) =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        const sliders = await trackSliders("pan");
        if (sliders.length === 0 || trackIndex > sliders.length) {
          throw new GBError(
            "ELEMENT_NOT_FOUND",
            `Found ${sliders.length} pan knobs but trackIndex is ${trackIndex}.`,
            "Pan knobs only show at larger track heights; try enlarging tracks in GarageBand.",
          );
        }
        const out = await setSliderAt(sliders[trackIndex - 1], pan / 100);
        return ok(`Track ${trackIndex} pan set to ${pan}${out !== null ? ` (readback ${(out * 100).toFixed(0)})` : ""}.`);
      }),
  );

  server.registerTool(
    "gb_set_master_volume",
    {
      title: "Set master volume",
      description: "Set the master output volume slider (0-100, ~71 = 0 dB).",
      inputSchema: {
        level: z.number().min(0).max(100),
      },
    },
    async ({ level }) =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        const out = await setGroupSlider("Control Bar", "master volume", level / 100);
        if (out === null) {
          throw new GBError("ELEMENT_NOT_FOUND", "Master volume slider not found in the control bar.");
        }
        return ok(`Master volume set to ${level} (readback ${(out * 100).toFixed(0)}).`);
      }),
  );

  server.registerTool(
    "gb_toggle_smart_controls",
    {
      title: "Toggle Smart Controls",
      description:
        "Show/hide the Smart Controls pane (B) — the knobs that shape the selected track's sound: filter cutoff/resonance, envelope attack/release, effects sends. Open it, then gb_list_smart_controls to see what this patch exposes.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        await ui.keystroke("b");
        await sleep(600);
        return ok("Smart Controls toggled. Run gb_list_smart_controls to see the knobs.");
      }),
  );

  server.registerTool(
    "gb_list_smart_controls",
    {
      title: "List Smart Controls",
      description:
        "List the knobs/switches the Smart Controls pane exposes for the selected track's patch — names and current values. What appears depends on the patch (synths expose cutoff/resonance/attack; others expose tone/reverb/etc). Open the pane first with gb_toggle_smart_controls.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        const hits = await scanGroup(
          "Smart Controls",
          `(role === 'AXSlider' || role === 'AXCheckBox' || role === 'AXPopUpButton') && desc.length > 0`,
          80,
        );
        if (hits === null) {
          throw new GBError(
            "ELEMENT_NOT_FOUND",
            "Smart Controls pane not found.",
            "Open it with gb_toggle_smart_controls (B), then retry.",
          );
        }
        if (hits.length === 0) return ok("Smart Controls pane is open but exposes no adjustable controls for this patch.");
        return ok(
          hits
            .map((h) => `${h.text} [${h.role.replace("AX", "")}]${h.value !== null ? ` = ${h.value}` : ""}`)
            .join("\n"),
        );
      }),
  );

  server.registerTool(
    "gb_set_smart_control",
    {
      title: "Set Smart Control",
      description:
        "Turn a Smart Controls knob by name (from gb_list_smart_controls) — e.g. filter cutoff, resonance, attack, release, reverb. Slider values are normalized 0-1. This shapes the actual synth/instrument sound of the selected track.",
      inputSchema: {
        control: z.string().min(2).describe("Control name or a distinctive part of it (case-insensitive)"),
        value: z.number().min(0).max(1).describe("Normalized 0-1"),
      },
    },
    async ({ control, value }) =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        const escaped = control.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const out = await setGroupSlider("Smart Controls", escaped, value);
        if (out === null) {
          const hits = await scanGroup(
            "Smart Controls",
            `role === 'AXSlider' && desc.length > 0`,
            80,
          );
          throw new GBError(
            "ELEMENT_NOT_FOUND",
            `No Smart Controls slider matching "${control}".` +
              (hits && hits.length
                ? ` Available: ${hits.map((h) => h.text).join(", ")}`
                : " The pane may be closed — gb_toggle_smart_controls first."),
          );
        }
        return ok(`"${control}" set to ${value} (readback ${out.toFixed(3)}).`);
      }),
  );
}

/** Set a specific slider (already located) by writing its value at its position via JXA. */
async function setSliderAt(hit: AxHit, value: number): Promise<number | null> {
  const { runJXA } = await import("../osa.js");
  const [x, y] = hit.pos!;
  const script = `
    const se = Application('System Events');
    const p = se.processes['GarageBand'];
    const w = p.windows[0];
    let target = null;
    const queue = [w];
    let visited = 0;
    while (queue.length > 0 && visited < 900 && target === null) {
      const el = queue.shift();
      visited++;
      try {
        if (String(el.role()) === 'AXSlider') {
          const pos = el.position();
          if (Math.abs(pos[0] - ${x}) < 3 && Math.abs(pos[1] - ${y}) < 3) { target = el; break; }
        }
      } catch (e) {}
      try {
        const kids = el.uiElements();
        for (let i = 0; i < kids.length; i++) queue.push(kids[i]);
      } catch (e) {}
    }
    if (target === null) { 'NOTFOUND'; } else {
      target.value = ${value};
      delay(0.2);
      String(target.value());
    }
  `;
  const out = await runJXA(script, 45_000);
  return out === "NOTFOUND" ? null : parseFloat(out);
}
