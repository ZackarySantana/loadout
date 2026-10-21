import { fileURLToPath } from "node:url"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))

for (const command of [
  ["npm", "run", "changeset", "--", "version"],
  [
    "npm",
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ],
]) {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (await child.exited)
    throw new Error(`Version command failed: ${command.join(" ")}`)
}
