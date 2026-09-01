# GarageBand MCP

An [MCP](https://modelcontextprotocol.io) server that lets AI agents control **GarageBand on macOS** — compose and record music, drive the transport, manage projects, and export songs. Works with any MCP client: Claude Code, Claude Desktop, Cursor, Cline, Zed, Windsurf, or your own agent.

GarageBand has no scripting API, so this server combines three techniques:

- **Virtual MIDI** — the server creates a virtual CoreMIDI source that GarageBand automatically listens to. Claude can literally *play notes into a record-armed track*: melodies, chords, drum patterns, streamed in time against the project tempo.
- **AppleScript** — project lifecycle (open, save, close, list) via GarageBand's Standard Suite.
- **UI automation** — transport keys, menus, and dialogs via System Events (needs Accessibility permission).

## Example

> "Create a new GarageBand project at 90 BPM and record a four-bar lo-fi chord progression, then a drum groove on a second track, and export it as an MP3."

The agent does this with `gb_new_project` → `gb_set_tempo` → `gb_record_sequence` → `gb_add_software_instrument_track` → `gb_record_sequence` → `gb_export_song`.

Ready-made music lives in [`examples/`](examples/) — from a simple melody to full multi-layer arrangements — each with an **MP3 preview** in [`examples/audio/`](examples/audio/) so you can hear it before running anything. A standalone player streams any of them into GarageBand without an MCP client:

```bash
node examples/play.mjs examples/edm-anthem.json
```

## Tools (30)

| Domain | Tools |
|---|---|
| Compose 🎹 | `gb_play_note`, `gb_play_chord`, `gb_play_sequence` (live audition), `gb_play_song` (multi-layer arrangements), `gb_record_sequence` (records into the project), `gb_all_notes_off` |
| Project | `gb_launch`, `gb_new_project`, `gb_open_project`, `gb_save_project`, `gb_close_project`, `gb_list_projects` |
| Transport | `gb_play`, `gb_stop`, `gb_record`, `gb_go_to_beginning`, `gb_toggle_cycle`, `gb_toggle_metronome`, `gb_toggle_count_in` |
| Tracks | `gb_add_software_instrument_track`, `gb_delete_selected_track`, `gb_select_track`, `gb_mute_selected_track`, `gb_solo_selected_track` |
| Tempo | `gb_get_tempo`, `gb_set_tempo` |
| Export | `gb_export_song` (AAC / MP3 / AIFF) |
| Inspect | `gb_check_permissions`, `gb_ui_state`, `gb_screenshot` |

Notes are written as names (`"C4"`, `"F#3"`), drum aliases (`"kick"`, `"snare"`, `"hihat"`, …), or raw MIDI numbers. Sequences are placed on a beat grid (`startBeat` + `durationBeats`) and converted to real time by tempo. Songs go further: named **layers** (drums, bass, strings, lead, FX) on separate MIDI channels, and a **tempo map** with instant changes or linear ramps — enough to express builds, drops, risers, falls, crescendos, accelerando and ritardando. The [examples](examples/) show all of it, **with MP3 previews you can listen to**: an [EDM anthem](examples/audio/edm-anthem.mp3) with a build, drop, and ritardando outro, and a [cinematic strings piece](examples/audio/cinematic-swell.mp3) with swells and tempo ramps.

## Requirements

- macOS with GarageBand installed (tested against GarageBand 10.4)
- Node.js ≥ 18 (MIDI uses prebuilt binaries — no Xcode tools needed)

## Install

**Claude Code:**

```bash
claude mcp add garageband -- npx -y garageband-mcp
```

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "garageband": {
      "command": "npx",
      "args": ["-y", "garageband-mcp"]
    }
  }
}
```

**Cursor** — `~/.cursor/mcp.json` (or a project's `.cursor/mcp.json`), **Cline** — `cline_mcp_settings.json` via *MCP Servers → Configure*, and **Windsurf** — `~/.codeium/windsurf/mcp_config.json` all use the same shape:

```json
{
  "mcpServers": {
    "garageband": {
      "command": "npx",
      "args": ["-y", "garageband-mcp"]
    }
  }
}
```

**VS Code (GitHub Copilot agent mode)** — `.vscode/mcp.json`:

```json
{
  "servers": {
    "garageband": { "type": "stdio", "command": "npx", "args": ["-y", "garageband-mcp"] }
  }
}
```

**Zed** — `settings.json`:

```json
{
  "context_servers": {
    "garageband": { "command": { "path": "npx", "args": ["-y", "garageband-mcp"] } }
  }
}
```

**Your own agent** — it's a standard MCP stdio server, so any MCP SDK connects to it. Python, for example:

```python
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

params = StdioServerParameters(command="npx", args=["-y", "garageband-mcp"])
async with stdio_client(params) as (read, write):
    async with ClientSession(read, write) as session:
        await session.initialize()
        await session.call_tool("gb_play_chord", {"notes": ["C4", "E4", "G4"]})
```

Any framework that speaks MCP (OpenAI Agents SDK, LangChain MCP adapters, custom loops) works the same way — launch `npx -y garageband-mcp` as a stdio server.

**From source:**

```bash
git clone https://github.com/visualfart/garageband-mcp.git
cd garageband-mcp
npm install && npm run build
# then use `node /path/to/garageband-mcp/dist/index.js` as the server command
```

## macOS permissions

The first tool call will surface what's missing (run `gb_check_permissions`), but you'll need:

1. **Accessibility** — System Settings ▸ Privacy & Security ▸ **Accessibility** ▸ enable the app hosting the server (Terminal, iTerm, Claude Desktop, …). Required for transport keys, menus, and dialogs.
2. **Automation** — the first UI call triggers a consent prompt to control "System Events". Click Allow.
3. **Screen Recording** (optional) — same Settings pane; only needed for `gb_screenshot`.

## How recording works

`gb_record_sequence` moves the playhead to the start, presses record, waits out GarageBand's count-in (computed from tempo and time signature), then streams your sequence as MIDI with a lookahead scheduler (bounded jitter). For tight alignment:

- set the project tempo to match the `tempo` you pass (`gb_set_tempo`)
- keep count-in on (`gb_toggle_count_in`) and tell the tool `countInBars`
- fine-tune with `startLatencyMs` if your machine adds latency

## Limitations

- GarageBand routes live MIDI to the one selected track, so `gb_play_song` auditions a whole mix on a single instrument. Real multi-instrument arrangements are built by recording layer by layer (`gb_record_sequence` + `gb_add_software_instrument_track`).
- GarageBand must be frontmost during UI operations (the server brings it forward).
- `gb_set_tempo` writes the LCD tempo slider's accessibility value and verifies by reading back; the LCD must be in a mode that shows tempo (the default).
- `gb_export_song` can't fully control the destination folder in every GarageBand version; it watches the filesystem and reports where the file landed.
- New projects use the Empty Project template.
- Menu automation assumes English localization.

## License

MIT
