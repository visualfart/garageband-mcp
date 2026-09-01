import { runAppleScript, runJXA, asStr, sleep } from "./osa.js";
import { GBError } from "./errors.js";
import * as gb from "./applescript.js";

export type Modifier = "command" | "option" | "shift" | "control";

let axChecked = false;

/** Probe System Events once; throws NO_AX_PERMISSION with setup instructions if blocked. */
export async function checkAccessibility(): Promise<void> {
  if (axChecked) return;
  await runAppleScript(
    `tell application "System Events" to get name of first application process`,
  );
  axChecked = true;
}

function modClause(mods: Modifier[]): string {
  if (mods.length === 0) return "";
  return ` using {${mods.map((m) => `${m} down`).join(", ")}}`;
}

/** Send a keystroke to the GarageBand process (it must be frontmost). */
export async function keystroke(chars: string, mods: Modifier[] = []): Promise<void> {
  await runAppleScript(
    `tell application "System Events" to tell process "GarageBand" to keystroke ${asStr(chars)}${modClause(mods)}`,
  );
}

/** Send a raw key code (36 = Return, 53 = Escape, 49 = Space, 51 = Delete). */
export async function keyCode(code: number, mods: Modifier[] = []): Promise<void> {
  await runAppleScript(
    `tell application "System Events" to tell process "GarageBand" to key code ${code}${modClause(mods)}`,
  );
}

export const KEY = { RETURN: 36, ESCAPE: 53, SPACE: 49, DELETE: 51, HOME: 115 } as const;

async function isFrontmost(): Promise<boolean> {
  const out = await runAppleScript(
    `tell application "System Events" to get frontmost of process "GarageBand"`,
  );
  return out === "true";
}

/**
 * Preflight for UI tools: accessibility OK, GarageBand running and frontmost,
 * optionally a project open, and no text field holding keyboard focus.
 */
export async function ensureReady(opts: { needsProject?: boolean } = {}): Promise<void> {
  await checkAccessibility();
  if (!(await gb.isRunning())) {
    throw new GBError(
      "NOT_RUNNING",
      "GarageBand is not running.",
      "Start it with gb_launch.",
    );
  }
  await gb.activate();
  const deadline = Date.now() + 3000;
  while (!(await isFrontmost())) {
    if (Date.now() > deadline) {
      throw new GBError("NOT_FRONTMOST", "Could not bring GarageBand to the front.");
    }
    await sleep(150);
  }
  if (opts.needsProject) await gb.requireProject();
  await escapeTextFieldFocus();
}

/** If a text field has keyboard focus (e.g. a track rename), press Escape so shortcuts work. */
async function escapeTextFieldFocus(): Promise<void> {
  try {
    const out = await runAppleScript(
      `tell application "System Events" to tell process "GarageBand"
        try
          set f to value of attribute "AXFocusedUIElement"
          return role of f
        on error
          return "none"
        end try
      end tell`,
    );
    if (out === "AXTextField" || out === "AXTextArea") {
      await keyCode(KEY.ESCAPE);
      await sleep(100);
    }
  } catch {
    // best effort — focus probing is allowed to fail silently
  }
}

/**
 * Click a menu bar path like ["Share", "Export Song to Disk…"].
 * On a missing item, reports the actual items found at that level.
 */
export async function clickMenu(path: [string, string]): Promise<void> {
  const [barItem, item] = path;
  const script = `tell application "System Events" to tell process "GarageBand"
    if not (exists menu bar item ${asStr(barItem)} of menu bar 1) then
      return "NOBAR:" & (name of menu bar items of menu bar 1) as text
    end if
    if not (exists menu item ${asStr(item)} of menu 1 of menu bar item ${asStr(barItem)} of menu bar 1) then
      set itemNames to name of menu items of menu 1 of menu bar item ${asStr(barItem)} of menu bar 1
      set AppleScript's text item delimiters to ", "
      return "NOITEM:" & (itemNames as text)
    end if
    click menu item ${asStr(item)} of menu 1 of menu bar item ${asStr(barItem)} of menu bar 1
    return "OK"
  end tell`;
  const out = await runAppleScript(script);
  if (out.startsWith("NOBAR:")) {
    throw new GBError(
      "MENU_NOT_FOUND",
      `Menu "${barItem}" not found. Available menus: ${out.slice(6)}`,
    );
  }
  if (out.startsWith("NOITEM:")) {
    throw new GBError(
      "MENU_NOT_FOUND",
      `Menu item "${item}" not found in "${barItem}". Available items: ${out.slice(7)}`,
    );
  }
}

export interface SheetInfo {
  present: boolean;
  buttons: string[];
  textFields: string[];
  radioButtons: string[];
  popUps: string[];
  staticTexts: string[];
}

/** Describe the front sheet/dialog attached to window 1 (for driving and for error reports). */
export async function frontSheet(): Promise<SheetInfo> {
  const script = `
    const se = Application('System Events');
    const p = se.processes['GarageBand'];
    const result = { present: false, buttons: [], textFields: [], radioButtons: [], popUps: [], staticTexts: [] };
    try {
      const wins = p.windows();
      if (wins.length > 0) {
        const sheets = p.windows[0].sheets();
        if (sheets.length > 0) {
          const s = p.windows[0].sheets[0];
          result.present = true;
          const grab = (coll, key, attr) => {
            try {
              coll().forEach(el => {
                try { const v = attr === 'value' ? el.value() : el.name(); if (v !== null && v !== undefined) result[key].push(String(v)); }
                catch (e) { result[key].push(''); }
              });
            } catch (e) {}
          };
          grab(s.buttons, 'buttons', 'name');
          grab(s.textFields, 'textFields', 'value');
          grab(s.radioButtons, 'radioButtons', 'name');
          grab(s.popUpButtons, 'popUps', 'value');
          grab(s.staticTexts, 'staticTexts', 'value');
        }
      }
    } catch (e) {}
    JSON.stringify(result);
  `;
  const out = await runJXA(script);
  return JSON.parse(out) as SheetInfo;
}

/** Click a button by title on the front sheet of window 1. */
export async function clickSheetButton(title: string): Promise<void> {
  const out = await runAppleScript(
    `tell application "System Events" to tell process "GarageBand"
      if not (exists sheet 1 of window 1) then return "NOSHEET"
      if not (exists button ${asStr(title)} of sheet 1 of window 1) then return "NOBUTTON"
      click button ${asStr(title)} of sheet 1 of window 1
      return "OK"
    end tell`,
  );
  if (out !== "OK") {
    const info = await frontSheet();
    throw new GBError(
      "DIALOG_UNEXPECTED",
      `Could not click button "${title}" (${out}). Current sheet: ${JSON.stringify(info)}`,
    );
  }
}

/** Click a radio button by title on the front sheet (used for export format selection). */
export async function clickSheetRadio(title: string): Promise<void> {
  const out = await runAppleScript(
    `tell application "System Events" to tell process "GarageBand"
      if not (exists sheet 1 of window 1) then return "NOSHEET"
      if not (exists radio button ${asStr(title)} of sheet 1 of window 1) then return "NOBUTTON"
      click radio button ${asStr(title)} of sheet 1 of window 1
      return "OK"
    end tell`,
  );
  if (out !== "OK") {
    const info = await frontSheet();
    throw new GBError(
      "DIALOG_UNEXPECTED",
      `Could not select radio "${title}" (${out}). Current sheet: ${JSON.stringify(info)}`,
    );
  }
}

/** Focus the first text field of the front sheet, select all, and type a value. */
export async function setSheetTextField(value: string, index = 1): Promise<void> {
  const out = await runAppleScript(
    `tell application "System Events" to tell process "GarageBand"
      if not (exists sheet 1 of window 1) then return "NOSHEET"
      if not (exists text field ${index} of sheet 1 of window 1) then return "NOFIELD"
      set focused of text field ${index} of sheet 1 of window 1 to true
      return "OK"
    end tell`,
  );
  if (out !== "OK") {
    const info = await frontSheet();
    throw new GBError(
      "DIALOG_UNEXPECTED",
      `Could not focus text field ${index} (${out}). Current sheet: ${JSON.stringify(info)}`,
    );
  }
  await keystroke("a", ["command"]);
  await sleep(80);
  await keystroke(value);
}

/** Wait until a sheet appears (or not) on window 1. Returns whether one is present. */
export async function waitForSheet(present: boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await frontSheet();
    if (info.present === present) return true;
    await sleep(250);
  }
  return false;
}

/** True double-click at screen coordinates via a CGEvent (System Events can't synthesize one). */
export async function doubleClickAt(x: number, y: number): Promise<void> {
  const script = `
    ObjC.import('CoreGraphics');
    const pt = { x: ${x}, y: ${y} };
    function click(clickState) {
      const down = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDown, pt, $.kCGMouseButtonLeft);
      $.CGEventSetIntegerValueField(down, $.kCGMouseEventClickState, clickState);
      $.CGEventPost($.kCGHIDEventTap, down);
      const up = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseUp, pt, $.kCGMouseButtonLeft);
      $.CGEventSetIntegerValueField(up, $.kCGMouseEventClickState, clickState);
      $.CGEventPost($.kCGHIDEventTap, up);
    }
    click(1);
    delay(0.08);
    click(2);
    'OK';
  `;
  await runJXA(script);
}

export interface WindowBounds {
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
}

export async function frontWindowBounds(): Promise<WindowBounds> {
  const out = await runAppleScript(
    `tell application "System Events" to tell process "GarageBand"
      if not (exists window 1) then return "NOWINDOW"
      set p to position of window 1
      set s to size of window 1
      set n to name of window 1
      return ((item 1 of p) as text) & "," & ((item 2 of p) as text) & "," & ((item 1 of s) as text) & "," & ((item 2 of s) as text) & "|" & n
    end tell`,
  );
  if (out === "NOWINDOW") {
    throw new GBError("NO_PROJECT", "GarageBand has no window open.");
  }
  const [nums, name] = out.split("|");
  const [x, y, w, h] = nums.split(",").map((v) => parseInt(v, 10));
  return { x, y, w, h, name: name ?? "" };
}
