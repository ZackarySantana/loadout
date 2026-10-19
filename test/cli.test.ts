import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripVTControlCharacters } from "node:util"

// The native renderer emits cursor-addressed *diffs*, not whole text frames.
// Track the small VT subset needed to inspect the actual PTY screen, rather
// than matching stale text or concatenating unrelated incremental writes.
function terminalScreen(cols: number, rows: number) {
  const cells = Array.from({ length: rows }, () =>
    Array<string>(cols).fill(" "),
  )
  let pending = "",
    x = 0,
    y = 0
  return {
    text: () => cells.map((row) => row.join("")).join("\n"),
    write(chunk: string) {
      pending += chunk
      while (pending.length) {
        if (pending[0] === "\u001b") {
          if (pending.length < 2) return
          if (pending[1] === "[") {
            const match = /^\u001b\[([0-?]*)([ -/]*)([@-~])/.exec(pending)
            if (!match) return
            pending = pending.slice(match[0].length)
            const values = match[1]!.split(";").map(Number)
            const n = values[0] || 1
            switch (match[3]) {
              case "H":
              case "f":
                y = (values[0] || 1) - 1
                x = (values[1] || 1) - 1
                break
              case "A":
                y -= n
                break
              case "B":
                y += n
                break
              case "C":
                x += n
                break
              case "D":
                x -= n
                break
              case "G":
                x = n - 1
                break
              case "d":
                y = n - 1
                break
              case "J":
                if (values[0] === 2 || values[0] === 3)
                  cells.forEach((row) => row.fill(" "))
                break
              case "K":
                cells[y]?.fill(
                  " ",
                  values[0] === 2 ? 0 : x,
                  values[0] === 1 ? x + 1 : cols,
                )
                break
            }
            x = Math.max(0, Math.min(cols - 1, x))
            y = Math.max(0, Math.min(rows - 1, y))
          } else if ("]P_^".includes(pending[1]!)) {
            const end = /\u0007|\u001b\\/.exec(pending)
            if (!end) return
            pending = pending.slice(end.index + end[0].length)
          } else pending = pending.slice(2)
          continue
        }
        const char = String.fromCodePoint(pending.codePointAt(0)!)
        pending = pending.slice(char.length)
        if (char === "\r") x = 0
        else if (char === "\n") y = Math.min(rows - 1, y + 1)
        else if (char === "\b") x = Math.max(0, x - 1)
        else if (char >= " ") {
          cells[y]![x] = char
          x = Math.min(cols - 1, x + 1)
        }
      }
    },
  }
}

test("built CLI navigates bundled kits and updates a live answer in a real PTY outside the checkout", async () => {
  const checkout = fileURLToPath(new URL("..", import.meta.url))
  const build = Bun.spawn(["bun", "scripts/build.ts"], {
    cwd: checkout,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [buildStatus, stdout, stderr] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ])
  if (buildStatus !== 0)
    throw new Error(`CLI build failed (${buildStatus}):\n${stdout}${stderr}`)
  expect(await Bun.file(join(checkout, "dist/cli.js")).exists()).toBe(true)

  const root = await mkdtemp("/tmp/opencode/loadout-cli-")
  const home = join(root, "home")
  const repository = join(root, "external-repo")
  await Promise.all([home, repository].map((path) => mkdir(path)))
  let output = ""
  const screen = terminalScreen(160, 50)
  const decoder = new TextDecoder()
  const terminal = new Bun.Terminal({
    cols: 160,
    rows: 50,
    data(_terminal, bytes) {
      const chunk = decoder.decode(bytes, { stream: true })
      output += chunk
      screen.write(chunk)
    },
  })
  const child = Bun.spawn(["bun", join(checkout, "dist/cli.js")], {
    cwd: repository,
    env: { ...process.env, HOME: home, TERM: "xterm-256color" },
    terminal,
  })
  const text = () => screen.text()
  const waitFor = async (description: string, predicate: () => boolean) => {
    const deadline = Date.now() + 8000
    while (!predicate() && Date.now() < deadline && child.exitCode === null)
      await Bun.sleep(20)
    if (!predicate())
      throw new Error(
        `PTY did not ${description}; exit=${child.exitCode}\n${text()}\nRaw tail: ${stripVTControlCharacters(output).slice(-1000)}`,
      )
  }
  const send = async (keys: string) => {
    terminal.write(keys)
    await Bun.sleep(60)
  }
  try {
    await waitFor("show the bundled catalog", () => text().includes("built-in"))
    await send(" ")
    await waitFor(
      "browse bundled kits",
      () =>
        text().includes("Catalogs / Loadout") && text().includes("Greenfield"),
    )
    // Locate the bundled configurable kit by navigating the real list, rather
    // than relying on its current position in the catalog.
    for (
      let attempt = 0;
      attempt < 20 && !text().includes("› ○ Project context and deployment");
      attempt++
    )
      await send("\u001b[B")
    await waitFor("select Project context", () =>
      text().includes("› ○ Project context and deployment"),
    )
    await send(" ")
    await waitFor(
      "open inline questions",
      () =>
        text().includes("Install where?") &&
        text().includes("What is this project called?"),
    )
    // Scope is one horizontal row; Down moves directly to the first question.
    await send("\u001b[B")
    await waitFor("select the project-name row", () =>
      text().includes("› What is this project called?"),
    )
    await send(" ")
    await waitFor("focus the answer editor", () =>
      text().includes("Type an answer"),
    )
    output = ""
    await send("\u001b[F runtime smoke")
    await waitFor("render the changed answer live", () =>
      text().includes("My project runtime smoke"),
    )
    // Both the inline row and the contribution preview must react before Enter.
    expect(
      text().match(/My project runtime smoke/g)?.length,
    ).toBeGreaterThanOrEqual(2)
    await send("\r")
    output = ""
    await send("\u0003")
    await waitFor("protect the unapplied form on exit", () =>
      text().includes("Exit Loadout?"),
    )
    await send(" ")
    expect(child.exitCode).toBeNull()
    expect(text()).toContain("q exit · Esc stay")
    await send("q")
    await waitFor("exit after confirmation", () => child.exitCode !== null)
    expect(await child.exited).toBe(0)
    expect(await Bun.file(join(repository, "AGENTS.md")).exists()).toBe(false)
    expect(await Bun.file(join(home, ".loadout/state.json")).exists()).toBe(
      false,
    )
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
    terminal.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
