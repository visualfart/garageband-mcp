import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/music.ts", "src/smf.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  clean: true,
  sourcemap: false,
  dts: false,
});
