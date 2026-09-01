import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ok, guarded, GBError } from "../errors.js";
import * as ui from "../ui.js";
import { sleep } from "../osa.js";

const FORMAT_EXT: Record<string, string> = { aac: ".m4a", mp3: ".mp3", aiff: ".aif" };
const FORMAT_RADIO: Record<string, string[]> = {
  aac: ["AAC"],
  mp3: ["MP3"],
  aiff: ["AIFF"],
};

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/** Wait until the file exists and its size is stable across two polls. */
async function waitForFile(path: string, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  let last: number | null = null;
  while (Date.now() < deadline) {
    const size = await fileSize(path);
    if (size !== null && size > 0 && size === last) return size;
    last = size;
    await sleep(1500);
  }
  return null;
}

export function registerExportTools(server: McpServer): void {
  server.registerTool(
    "gb_export_song",
    {
      title: "Export song to disk",
      description:
        "Export the whole song as an audio file via Share ▸ Export Song to Disk. Drives the export sheet (filename, format) and detects completion by watching the filesystem. Location control in the sheet is limited — the file lands in GarageBand's last-used export folder unless the go-to-folder shortcut works; the tool reports where it found the file.",
      inputSchema: {
        filename: z.string().describe("Filename without extension"),
        format: z.enum(["aac", "mp3", "aiff"]).describe("aac → .m4a, mp3 → .mp3, aiff → .aif"),
        directory: z
          .string()
          .optional()
          .describe("Absolute directory to export into (attempted via go-to-folder; default = last-used)"),
        waitTimeoutSec: z.number().int().min(10).max(1800).optional().describe("Default 300"),
      },
    },
    async ({ filename, format, directory, waitTimeoutSec }) =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });

        // menu item title uses a real ellipsis; fall back to three dots for safety
        try {
          await ui.clickMenu(["Share", "Export Song to Disk…"]);
        } catch (e) {
          if (e instanceof GBError && e.code === "MENU_NOT_FOUND") {
            await ui.clickMenu(["Share", "Export Song to Disk..."]);
          } else {
            throw e;
          }
        }

        if (!(await ui.waitForSheet(true, 6000))) {
          throw new GBError(
            "DIALOG_UNEXPECTED",
            "The export sheet did not appear after clicking the Share menu.",
          );
        }

        await ui.setSheetTextField(filename);
        await sleep(200);

        // pick the format radio button (sheet dumps go into the error if titles differ)
        let radioOk = false;
        for (const title of FORMAT_RADIO[format]) {
          try {
            await ui.clickSheetRadio(title);
            radioOk = true;
            break;
          } catch {
            /* try next alias */
          }
        }
        if (!radioOk) {
          const info = await ui.frontSheet();
          throw new GBError(
            "DIALOG_UNEXPECTED",
            `Could not select the ${format.toUpperCase()} format radio button. Sheet contents: ${JSON.stringify(info)}`,
          );
        }
        await sleep(200);

        // best-effort location: go-to-folder shortcut works when the sheet embeds a save panel
        if (directory) {
          await ui.keystroke("g", ["command", "shift"]);
          await sleep(800);
          const sub = await ui.frontSheet();
          if (sub.present && sub.textFields.length > 0) {
            await ui.keystroke(directory);
            await sleep(200);
            await ui.keyCode(ui.KEY.RETURN);
            await sleep(800);
          }
        }

        await ui.clickSheetButton("Export");

        const ext = FORMAT_EXT[format];
        const timeoutMs = (waitTimeoutSec ?? 300) * 1000;
        const candidates = [
          ...(directory ? [join(directory, filename + ext)] : []),
          join(homedir(), "Music", filename + ext),
          join(homedir(), "Desktop", filename + ext),
          join(homedir(), "Downloads", filename + ext),
        ];
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          for (const path of candidates) {
            const size = await waitForFile(path, 100);
            if (size !== null) {
              return ok(`Exported: ${path} (${(size / 1024 / 1024).toFixed(2)} MB)`);
            }
          }
          await sleep(2000);
        }
        throw new GBError(
          "EXPORT_TIMEOUT",
          `Export did not produce ${filename}${ext} in any expected location within ${waitTimeoutSec ?? 300}s.`,
          "The export may still be running, or it went to GarageBand's last-used folder. Check gb_ui_state / gb_screenshot.",
        );
      }),
  );
}
