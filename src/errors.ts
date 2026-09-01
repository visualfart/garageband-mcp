export type GBErrorCode =
  | "NOT_RUNNING"
  | "NOT_FRONTMOST"
  | "NO_PROJECT"
  | "NO_AX_PERMISSION"
  | "MENU_NOT_FOUND"
  | "DIALOG_UNEXPECTED"
  | "ELEMENT_NOT_FOUND"
  | "EXPORT_TIMEOUT"
  | "MIDI_INIT_FAILED"
  | "OSASCRIPT_TIMEOUT"
  | "OSASCRIPT_ERROR"
  | "INVALID_INPUT";

export class GBError extends Error {
  constructor(
    public code: GBErrorCode,
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = "GBError";
  }
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function image(base64: string, mimeType: string, note?: string): ToolResult {
  const content: ToolResult["content"] = [{ type: "image", data: base64, mimeType }];
  if (note) content.push({ type: "text", text: note });
  return { content };
}

export function errorResult(e: unknown): ToolResult {
  let text: string;
  if (e instanceof GBError) {
    text = `[${e.code}] ${e.message}`;
    if (e.hint) text += `\nHint: ${e.hint}`;
  } else if (e instanceof Error) {
    text = e.message;
  } else {
    text = String(e);
  }
  return { content: [{ type: "text", text }], isError: true };
}

/** Wrap a tool body so any throw becomes a structured MCP error result. */
export async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return errorResult(e);
  }
}
