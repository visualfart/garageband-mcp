declare module "easymidi" {
  export class Output {
    constructor(name: string, virtual?: boolean);
    send(type: "noteon" | "noteoff", args: { note: number; velocity: number; channel: number }): void;
    send(type: "cc", args: { controller: number; value: number; channel: number }): void;
    close(): void;
  }
  export class Input {
    constructor(name: string, virtual?: boolean);
    close(): void;
  }
  export function getOutputs(): string[];
  export function getInputs(): string[];
}
