import { execFile } from "node:child_process";
import { GBError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 10_000;

function run(
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            reject(
              new GBError(
                "OSASCRIPT_TIMEOUT",
                `osascript timed out after ${timeoutMs}ms — a modal dialog may be blocking GarageBand.`,
                "Check the GarageBand window for an open dialog (gb_ui_state / gb_screenshot can show it).",
              ),
            );
            return;
          }
          const msg = (stderr || err.message || "").trim();
          if (/not allowed assistive access|osascript is not allowed|-25211|-1719/.test(msg)) {
            reject(
              new GBError(
                "NO_AX_PERMISSION",
                "macOS Accessibility permission is missing for the app running this MCP server.",
                "Open System Settings ▸ Privacy & Security ▸ Accessibility and enable the host app (e.g. Terminal, iTerm, Claude, or Claude Desktop), then retry. The first run may also show an Automation consent prompt for 'System Events' — click Allow.",
              ),
            );
            return;
          }
          reject(new GBError("OSASCRIPT_ERROR", msg || "osascript failed"));
          return;
        }
        resolve(stdout.replace(/\n$/, ""));
      },
    );
  });
}

/** Run an AppleScript source string; script is passed via argv (no shell involved). */
export function runAppleScript(script: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return run(["-e", script], timeoutMs);
}

/** Run a JXA (JavaScript for Automation) source string. */
export function runJXA(script: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return run(["-l", "JavaScript", "-e", script], timeoutMs);
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
export function asStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
