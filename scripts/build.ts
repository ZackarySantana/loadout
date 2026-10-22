import { chmod } from "node:fs/promises"
import solidPlugin from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["src/cli.tsx"],
  outdir: "dist",
  target: "node",
  external: ["@opentui/core", "@opentui/core/*"],
  plugins: [
    {
      name: "solid-client-runtime",
      setup(build) {
        // OpenTUI imports these client modules directly. Resolve bare imports
        // to the same paths so Node conditions cannot create a second runtime.
        build.onResolve({ filter: /^solid-js(?:\/store)?$/ }, ({ path }) => ({
          path: Bun.resolveSync(
            path === "solid-js"
              ? "solid-js/dist/solid.js"
              : "solid-js/store/dist/store.js",
            import.meta.dir,
          ),
        }))
      },
    },
    solidPlugin,
  ],
  define: { LOADOUT_BUNDLED: "true" },
})
if (!result.success) throw new AggregateError(result.logs, "Build failed")
const launcher = await Bun.build({
  entrypoints: ["src/launcher.ts"],
  outdir: "dist",
  target: "node",
  define: { LOADOUT_BUNDLED: "true" },
})
if (!launcher.success)
  throw new AggregateError(launcher.logs, "Launcher build failed")
await chmod("dist/cli.js", 0o755)
await chmod("dist/launcher.js", 0o755)
