import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = await realpath(fileURLToPath(new URL("../site", import.meta.url)))
const port = Number(process.env.PORT ?? "4173")
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be an integer from 1 to 65535")

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", { status: 405 })
    try {
      const path = decodeURIComponent(new URL(request.url).pathname)
      const candidate = await realpath(
        resolve(root, `.${path === "/" ? "/index.html" : path}`),
      )
      const within = relative(root, candidate)
      if (within === ".." || within.startsWith("../") || isAbsolute(within))
        return new Response("Not found", { status: 404 })
      const file = Bun.file(candidate)
      if (!(await file.exists()))
        return new Response("Not found", { status: 404 })
      return new Response(request.method === "HEAD" ? null : file, {
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
        },
      })
    } catch {
      return new Response("Not found", { status: 404 })
    }
  },
})
console.log(`Loadout docs: ${server.url}`)
