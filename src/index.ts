#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerProjectTools } from "./tools/project.js";
import { registerTransportTools } from "./tools/transport.js";
import { registerTrackTools } from "./tools/tracks.js";
import { registerComposeTools } from "./tools/compose.js";
import { registerTempoTools } from "./tools/tempo.js";
import { registerMixTools } from "./tools/mix.js";
import { registerLoopTools } from "./tools/loops.js";
import { registerExportTools } from "./tools/export.js";
import { registerInspectTools } from "./tools/inspect.js";
import { closeMidi } from "./midi.js";
import { cancelActive } from "./scheduler.js";

const server = new McpServer({
  name: "garageband-mcp",
  version: "0.1.0",
});

registerInspectTools(server);
registerProjectTools(server);
registerTransportTools(server);
registerTrackTools(server);
registerComposeTools(server);
registerTempoTools(server);
registerMixTools(server);
registerLoopTools(server);
registerExportTools(server);

function shutdown(): void {
  cancelActive();
  closeMidi();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("garageband-mcp running on stdio");
