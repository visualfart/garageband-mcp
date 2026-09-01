import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, guarded, GBError } from "../errors.js";
import * as gb from "../applescript.js";
import * as ui from "../ui.js";
import { sleep } from "../osa.js";

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    "gb_launch",
    {
      title: "Launch GarageBand",
      description: "Launch GarageBand (or bring it to the front if already running).",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        await gb.launchAndWait();
        if (await gb.chooserOpen()) {
          return ok(
            "GarageBand is running and showing the project chooser. Use gb_new_project to create a project, or gb_open_project with a path.",
          );
        }
        const n = await gb.documentCount();
        return ok(
          `GarageBand is running and frontmost. Open projects: ${n}.` +
            (n === 0 ? " No project is open — use gb_new_project or gb_open_project." : ""),
        );
      }),
  );

  server.registerTool(
    "gb_new_project",
    {
      title: "New project",
      description:
        "Create a new GarageBand project (Empty Project template) with a default software-instrument track. Drives the project chooser via UI automation.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        await gb.launchAndWait();
        await ui.ensureReady();
        // Cmd+N opens the project chooser with "Empty Project" selected by default
        // (skip it if the chooser is already showing); Return confirms it, and a
        // second Return accepts the default track type (Software Instrument) if
        // that dialog appears.
        if (!(await gb.chooserOpen())) {
          await ui.keystroke("n", ["command"]);
          await sleep(1500);
        }
        await ui.keyCode(ui.KEY.RETURN);
        await sleep(2000);
        await ui.keyCode(ui.KEY.RETURN);
        await sleep(2500);
        const n = await gb.documentCount();
        if (n === 0) {
          throw new GBError(
            "DIALOG_UNEXPECTED",
            "A new project window did not appear.",
            "Take a gb_screenshot to see the current state — a dialog may need different handling.",
          );
        }
        const docs = await gb.listDocuments();
        return ok(
          `New project created: "${docs[0]?.name}". It has one software-instrument track, record-armed and ready for MIDI (try gb_play_note).`,
        );
      }),
  );

  server.registerTool(
    "gb_open_project",
    {
      title: "Open project",
      description: "Open an existing GarageBand project (.band) by absolute POSIX path.",
      inputSchema: {
        path: z.string().describe("Absolute path to the .band project"),
      },
    },
    async ({ path }) =>
      guarded(async () => {
        await gb.launchAndWait();
        await gb.openProject(path);
        await sleep(1500);
        const docs = await gb.listDocuments();
        return ok(`Opened project. Open documents: ${docs.map((d) => d.name).join(", ")}`);
      }),
  );

  server.registerTool(
    "gb_save_project",
    {
      title: "Save project",
      description:
        "Save the front project. If it has never been saved, a save sheet appears and the optional name is typed in (saved to the default location, usually ~/Music/GarageBand).",
      inputSchema: {
        name: z.string().optional().describe("Project name to use if the save dialog appears"),
      },
    },
    async ({ name }) =>
      guarded(async () => {
        await ui.ensureReady({ needsProject: true });
        await ui.keystroke("s", ["command"]);
        await sleep(1000);
        const sheet = await ui.frontSheet();
        if (sheet.present) {
          if (name) await ui.setSheetTextField(name);
          await sleep(200);
          await ui.keyCode(ui.KEY.RETURN);
          await sleep(1500);
        }
        const docs = await gb.listDocuments();
        const d = docs[0];
        return ok(
          d
            ? `Saved "${d.name}"${d.path ? ` at ${d.path}` : ""}.`
            : "Save keystroke sent.",
        );
      }),
  );

  server.registerTool(
    "gb_close_project",
    {
      title: "Close project",
      description: "Close the front project, optionally discarding unsaved changes.",
      inputSchema: {
        discardChanges: z
          .boolean()
          .optional()
          .describe("true = close without saving; default saves first"),
      },
    },
    async ({ discardChanges }) =>
      guarded(async () => {
        await gb.requireProject();
        await gb.closeFrontDocument(discardChanges ? "no" : "yes");
        return ok("Project closed.");
      }),
  );

  server.registerTool(
    "gb_list_projects",
    {
      title: "List open projects",
      description: "List GarageBand's open project documents (name, path, modified state).",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const docs = await gb.listDocuments();
        if (docs.length === 0) return ok("No projects are open.");
        return ok(
          docs
            .map(
              (d, i) =>
                `${i + 1}. ${d.name}${d.path ? ` — ${d.path}` : " (unsaved)"}${d.modified ? " [modified]" : ""}`,
            )
            .join("\n"),
        );
      }),
  );
}
