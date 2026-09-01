import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, image, guarded, GBError } from "../errors.js";
import * as gb from "../applescript.js";
import * as ui from "../ui.js";
import { runAppleScript } from "../osa.js";

const exec = promisify(execFile);

export function registerInspectTools(server: McpServer): void {
  server.registerTool(
    "gb_check_permissions",
    {
      title: "Check permissions",
      description:
        "Verify the macOS permissions this server needs: Accessibility (for UI control) and whether GarageBand is installed/running. Run this first.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const lines: string[] = [];
        try {
          await ui.checkAccessibility();
          lines.push("✓ Accessibility permission: granted");
        } catch (e) {
          throw e;
        }
        const appExists = await stat("/Applications/GarageBand.app").then(
          () => true,
          () => false,
        );
        lines.push(appExists ? "✓ GarageBand: installed" : "✗ GarageBand: NOT FOUND in /Applications");
        lines.push((await gb.isRunning()) ? "✓ GarageBand: running" : "· GarageBand: not running (use gb_launch)");
        lines.push(
          "· Screenshots additionally need Screen Recording permission for the host app (System Settings ▸ Privacy & Security ▸ Screen Recording) — without it gb_screenshot captures only the wallpaper.",
        );
        return ok(lines.join("\n"));
      }),
  );

  server.registerTool(
    "gb_ui_state",
    {
      title: "Inspect UI state",
      description:
        "Report GarageBand's current state: running/frontmost, open documents, front window title, and any open dialog sheet (with its buttons/fields). Useful for debugging a stuck flow.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        if (!(await gb.isRunning())) return ok("GarageBand is not running.");
        await ui.checkAccessibility();
        const frontApp = await runAppleScript(
          `tell application "System Events" to get name of first application process whose frontmost is true`,
        );
        const docs = await gb.listDocuments();
        const lines = [
          `Frontmost app: ${frontApp}`,
          `Open projects: ${docs.length ? docs.map((d) => d.name).join(", ") : "none"}`,
        ];
        try {
          const win = await ui.frontWindowBounds();
          lines.push(`Front window: "${win.name}" (${win.w}×${win.h} at ${win.x},${win.y})`);
        } catch {
          lines.push("Front window: none");
        }
        const sheet = await ui.frontSheet();
        if (sheet.present) {
          lines.push(`Open dialog sheet: ${JSON.stringify(sheet)}`);
        } else {
          lines.push("No dialog sheet open.");
        }
        return ok(lines.join("\n"));
      }),
  );

  server.registerTool(
    "gb_screenshot",
    {
      title: "Screenshot GarageBand",
      description:
        "Capture the GarageBand window as an image so Claude can see the current state. Needs Screen Recording permission for the host app.",
      inputSchema: {
        savePath: z.string().optional().describe("Also save the full-resolution PNG here"),
      },
    },
    async ({ savePath }) =>
      guarded(async () => {
        await ui.ensureReady();
        const b = await ui.frontWindowBounds();
        const raw = join(tmpdir(), `gb-mcp-shot-${Date.now()}.png`);
        await exec("screencapture", ["-x", "-R", `${b.x},${b.y},${b.w},${b.h}`, raw]);
        if (savePath) {
          await exec("cp", [raw, savePath]);
        }
        // downscale so the payload stays small enough to return inline
        await exec("sips", ["-Z", "1200", raw]);
        const data = await readFile(raw);
        await exec("rm", ["-f", raw]);
        if (data.length < 100) {
          throw new GBError(
            "OSASCRIPT_ERROR",
            "Screenshot came back empty.",
            "Grant Screen Recording permission to the host app in System Settings ▸ Privacy & Security ▸ Screen Recording.",
          );
        }
        return image(
          data.toString("base64"),
          "image/png",
          `Window "${b.name}" (${b.w}×${b.h})${savePath ? `, full-res saved to ${savePath}` : ""}`,
        );
      }),
  );
}
