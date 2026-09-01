import { runAppleScript, asStr, sleep } from "./osa.js";
import { GBError } from "./errors.js";

const APP = '"GarageBand"';

export async function isRunning(): Promise<boolean> {
  const out = await runAppleScript(`application ${APP} is running`);
  return out === "true";
}

export async function activate(): Promise<void> {
  await runAppleScript(`tell application ${APP} to activate`);
}

export async function launchAndWait(timeoutMs = 30_000): Promise<void> {
  await activate();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isRunning()) return;
    await sleep(500);
  }
  throw new GBError("NOT_RUNNING", "GarageBand did not launch within the timeout.");
}

export interface GBDocument {
  name: string;
  path: string;
  modified: boolean;
}

/**
 * The "Choose a Project" chooser runs modally and blocks GarageBand's Apple
 * Event queue (a `count documents` sent then hangs until osascript times out).
 * Detect it via System Events, which stays responsive.
 */
export async function chooserOpen(): Promise<boolean> {
  try {
    const out = await runAppleScript(
      `tell application "System Events" to tell process "GarageBand" to get name of windows`,
      5000,
    );
    return /choose a project|project chooser/i.test(out);
  } catch {
    return false;
  }
}

export async function documentCount(): Promise<number> {
  if (!(await isRunning())) return 0;
  if (await chooserOpen()) return 0;
  const out = await runAppleScript(`tell application ${APP} to count documents`);
  return parseInt(out, 10) || 0;
}

export async function listDocuments(): Promise<GBDocument[]> {
  const n = await documentCount();
  const docs: GBDocument[] = [];
  for (let i = 1; i <= n; i++) {
    const out = await runAppleScript(
      `tell application ${APP}
        set d to document ${i}
        set docName to name of d
        set docPath to ""
        try
          set docPath to path of d
        end try
        set docMod to modified of d
        return docName & "\\n" & docPath & "\\n" & docMod
      end tell`,
    );
    const [name, path, modified] = out.split("\n");
    docs.push({ name, path, modified: modified === "true" });
  }
  return docs;
}

export async function openProject(posixPath: string): Promise<void> {
  await runAppleScript(
    `tell application ${APP}
      activate
      open POSIX file ${asStr(posixPath)}
    end tell`,
    30_000,
  );
}

/** AppleScript save of the front document. Throws if no document. */
export async function saveFrontDocument(): Promise<void> {
  await runAppleScript(`tell application ${APP} to save first document`, 30_000);
}

export async function closeFrontDocument(saving: "yes" | "no" | "ask"): Promise<void> {
  await runAppleScript(`tell application ${APP} to close first document saving ${saving}`, 30_000);
}

export async function requireProject(): Promise<void> {
  if (await chooserOpen()) {
    throw new GBError(
      "NO_PROJECT",
      "GarageBand is showing the project chooser — no project is open.",
      "Use gb_new_project to create one from the chooser, or gb_open_project with a path.",
    );
  }
  if ((await documentCount()) === 0) {
    throw new GBError(
      "NO_PROJECT",
      "No GarageBand project is open.",
      "Open one with gb_open_project or create one with gb_new_project.",
    );
  }
}
