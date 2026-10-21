import { chmod } from "node:fs/promises"
import solidPlugin from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["src/cli.tsx"],
  outdir: "dist",
  target: "bun",
  external: ["@opentui/core", "@opentui/core/*"],
  plugins: [solidPlugin],
  define: { LOADOUT_BUNDLED: "true" },
})
if (!result.success) throw new AggregateError(result.logs, "Build failed")
await chmod("dist/cli.js", 0o755)
