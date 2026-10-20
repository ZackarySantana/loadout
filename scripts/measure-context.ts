/** Historical evidence only: bun scripts/measure-context.ts. Never fetches or executes upstream code. */
import { createHash } from "node:crypto"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const retrievalDate = "2026-10-19"
const sources = [
  {
    id: "external-matt-questionnaire",
    name: "Matt Pocock: discovery questionnaire",
    description:
      "Interview stakeholders through a focused Markdown questionnaire, using Matt Pocock's to-questionnaire skill.",
    author: "Matt Pocock",
    repo: "mattpocock/skills",
    commit: "5beb35b040e3de97e54fa9e386d7e42d15c295c2",
    directory: "mattpocock/to-questionnaire",
    upstreamDirectory: "skills/productivity/to-questionnaire",
    license: "MIT",
    licensePath: "LICENSE",
    rationale:
      "A complete, focused stakeholder-discovery workflow without the issue trackers, scripts, or sibling-skill dependencies of larger engineering bundles.",
    limitations:
      "Explicitly user-invoked upstream; disable-model-invocation and Codex policy metadata are preserved. Hosts differ in their support for these controls. The skill writes a questionnaire only when invoked; installing this kit does not run it.",
    citations: [
      "https://www.aihero.dev/skills",
      "https://github.com/mattpocock/skills",
    ],
  },
  {
    id: "external-anthropic-design",
    name: "Anthropic: frontend design",
    description:
      "Plan and critique distinctive interfaces with Anthropic's frontend-design guidance; no bundled scripts or design assets.",
    author: "Anthropic",
    repo: "anthropics/skills",
    commit: "dbd4588f9e1033efb41dad4bef2f7947c8993d44",
    directory: "anthropic/frontend-design",
    upstreamDirectory: "skills/frontend-design",
    license: "Apache-2.0",
    licensePath: "skills/frontend-design/LICENSE.txt",
    rationale:
      "Self-contained interface-design planning, typography, copywriting, accessibility, and self-critique; no document-conversion binaries or scripts.",
    limitations:
      "Upstream describes its skills as educational demonstrations, not a guarantee of production behavior. Screenshots are optional and require host capabilities. Repository-wide third-party notices concern image/video/font components not present in this textual skill; none of those components are redistributed here.",
    citations: [
      "https://github.com/anthropics/skills",
      "https://anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills",
      "https://support.claude.com/en/articles/12512176-what-are-skills",
    ],
  },
  {
    id: "external-ponytail",
    name: "Ponytail: smallest complete change",
    description:
      "Use DietrichGebert's Ponytail skill for minimal, complete changes that preserve safety and existing project conventions.",
    author: "DietrichGebert",
    repo: "DietrichGebert/ponytail",
    commit: "09c434ab73ca43761c5d8b0c5d341926c2fba710",
    directory: "ponytail/ponytail",
    upstreamDirectory: "skills/ponytail",
    license: "MIT",
    licensePath: "LICENSE",
    rationale:
      "The user's spelling maps to a real upstream Ponytail project. Its core prompt is independently usable as a skill without lifecycle hooks, plugins, adapters, or scripts.",
    limitations:
      "Core skill only: no lifecycle hooks, automatic session activation, plugin commands, or other Ponytail skills. Once invoked, the text requests session persistence and lite/full/ultra modes; host behavior is not guaranteed. Its request for a small test never overrides explicit user constraints such as no new tests.",
    citations: [
      "https://github.com/DietrichGebert/ponytail",
      "https://github.com/DietrichGebert/ponytail/blob/09c434ab73ca43761c5d8b0c5d341926c2fba710/INSTALL.md",
    ],
  },
]

function measure(text: string) {
  return {
    utf8Bytes: Buffer.byteLength(text, "utf8"),
    unicodeCodePoints: [...text].length,
    whitespaceSeparatedWords: text.match(/\S+/gu)?.length ?? 0,
    lines:
      text.length === 0
        ? 0
        : text.split("\n").length - Number(text.endsWith("\n")),
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name)
      return entry.isDirectory() ? listFiles(path) : [path]
    }),
  )
  return paths.flat().sort()
}

type Measurement = ReturnType<typeof measure>
type SourceInfo = (typeof sources)[number]

interface EvidenceFileRecord extends Measurement {
  path: string
  installedPath: string
  upstreamPath: string | null
  sourceUrl: string | null
  sha256: string
}

interface SourceMeasurementRecord extends SourceInfo {
  retrievalDate: string
  skillName: string
  skillDescription: string
  sourceUrl: string
  supportingResources: string
  measurements: {
    fullFile: Measurement
    frontmatterWithDelimiters: Measurement
    descriptionValue: Measurement
    discoveryNameAndDescription: Measurement
    body: Measurement
  }
  files: EvidenceFileRecord[]
}

const records: SourceMeasurementRecord[] = []
for (const source of sources) {
  const directory = resolve(root, "site/evidence", source.directory)
  const skill = await readFile(resolve(directory, "SKILL.md"), "utf8")
  const match = /^---\n([\s\S]*?)\n---\n/.exec(skill)
  if (!match) throw new Error(`Missing frontmatter: ${source.directory}`)
  const frontmatter: unknown = parse(match[1]!)
  if (
    typeof frontmatter !== "object" ||
    frontmatter === null ||
    !("name" in frontmatter) ||
    typeof frontmatter.name !== "string" ||
    !("description" in frontmatter) ||
    typeof frontmatter.description !== "string"
  )
    throw new Error(`Invalid skill metadata: ${source.directory}`)
  const body = skill.slice(match[0].length)
  const fileRecords: EvidenceFileRecord[] = []
  for (const path of await listFiles(directory)) {
    const name = relative(directory, path)
    const content = await readFile(path, "utf8")
    const upstreamPath =
      name === "SOURCE.md"
        ? null
        : name === "LICENSE.txt"
          ? source.licensePath
          : `${source.upstreamDirectory}/${name}`
    fileRecords.push({
      path: relative(root, path),
      installedPath: name,
      upstreamPath,
      sourceUrl: upstreamPath
        ? `https://github.com/${source.repo}/blob/${source.commit}/${upstreamPath}`
        : null,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      ...measure(content),
    })
  }
  records.push({
    ...source,
    retrievalDate,
    skillName: frontmatter.name,
    skillDescription: frontmatter.description,
    sourceUrl: `https://github.com/${source.repo}/blob/${source.commit}/${source.upstreamDirectory}/SKILL.md`,
    supportingResources:
      "All upstream files in this selected skill directory are included; these skills reference no required external supporting Markdown, scripts, or binaries. SOURCE.md and the MIT license sidecars are packaging additions where not present upstream.",
    measurements: {
      fullFile: measure(skill),
      frontmatterWithDelimiters: measure(match[0]),
      descriptionValue: measure(frontmatter.description),
      discoveryNameAndDescription: measure(
        `${frontmatter.name}\n${frontmatter.description}\n`,
      ),
      body: measure(body),
    },
    files: fileRecords,
  })
}
const ponytail = sources[2]!
const comparisonPath = "site/evidence/ponytail/comparison/AGENTS.md"
const comparison = await readFile(resolve(root, comparisonPath), "utf8")
const result = {
  retrievalDate,
  methodology: {
    command: "bun scripts/measure-context.ts",
    operation:
      "Offline regeneration from historical UTF-8 evidence only. Reads the preserved snapshots without changing source bytes, licenses, or SOURCE.md notices. Writes this measurement inventory and the site presentation extract; never fetches remote content, installs kits, or generates runtime kit YAML. Historical commit pins reproduce this comparison only; live catalog update identity uses content hashes, not commits or dates.",
    units:
      "UTF-8 bytes use Buffer.byteLength; characters are Unicode code points ([...text].length), not UTF-16 units or grapheme clusters; words are maximal non-whitespace runs (/\\S+/gu); lines count LF-separated logical lines without a phantom empty line after a final LF. Empty text has zero lines.",
    separation:
      "Frontmatter includes both delimiter lines and their LF. Body is every character after the closing frontmatter delimiter LF, including the following blank line. Description is the parsed YAML scalar (folded for Ponytail), with no added newline. Discovery is exactly name + LF + parsed description + LF; not an observed host prompt format.",
    tokenization:
      "No tokenizer used. These are byte/character/word/line measurements, not token counts or measured runtime context savings.",
    illustrativeComparison:
      "An always-inline baseline can concatenate the exact same full SKILL.md files. An illustrative discovery-only state concatenates only discoveryNameAndDescription; activation then adds the selected full file (or body, if explicitly comparing body-only loading). Sum the appropriate fields. This is a conditional accounting illustration, not a benchmark: actual hosts may load more metadata, wrappers, license/support text, retain prior activations, or make skills always active.",
    licenseAndSupport:
      "Full-file skill measurements exclude license, source notices, and the optional Codex UI/policy metadata file. Separate file records preserve their historical packaging bytes; installedPath records the former package-relative path, not a current installation. Do not compare disk totals to prompt text as if they were the same thing.",
    agentsComparison:
      "The Ponytail AGENTS.md is a genuine upstream always-on rules alternative, not byte-identical to SKILL.md. Its measurement is an independent real-world reference; differences are not savings from equivalent content.",
  },
  sources: records,
  instructionsComparison: {
    path: comparisonPath,
    sourceUrl: `https://github.com/${ponytail.repo}/blob/${ponytail.commit}/AGENTS.md`,
    commit: ponytail.commit,
    retrievalDate,
    license: "MIT",
    licensePath: "site/evidence/ponytail/comparison/LICENSE.txt",
    installedByKits: false,
    sha256: createHash("sha256").update(comparison, "utf8").digest("hex"),
    measurements: measure(comparison),
  },
}
await writeFile(
  resolve(root, "site/evidence/external-sources.json"),
  `${JSON.stringify(result, null, 2)}\n`,
)
// Generate the downloadable extract from the same records; HTML remains a
// deliberately reviewed static presentation of these historical measurements.
const compact = (measurement: ReturnType<typeof measure>) => ({
  utf8Bytes: measurement.utf8Bytes,
  words: measurement.whitespaceSeparatedWords,
  lines: measurement.lines,
})
const sum = (field: "fullFile" | "discoveryNameAndDescription") =>
  records.reduce(
    (total, record) => total + record.measurements[field].utf8Bytes,
    0,
  )
const discoveryBytes = sum("discoveryNameAndDescription")
const extract = {
  retrievalDate,
  sourceInventory:
    "site/evidence/external-sources.json in the Loadout checkout",
  reproduce: "mise exec -- bun scripts/measure-context.ts",
  reproduceNotice:
    "Regenerates the historical evidence inventory and this presentation extract offline. Never fetches live catalog content, changes snapshots or notices, or generates runtime kit YAML. Does not update HTML.",
  extractMaintenance:
    "Review all site HTML measurement tables, activation cases, totals, citations, and dated references against the regenerated JSON. Review historical source pins, licenses, hashes, arithmetic, and methodology before sharing. These fixtures do not describe the current remote catalog inventory.",
  methodology: {
    bytes: "Exact UTF-8 bytes, Buffer.byteLength; no tokenizer used.",
    words: "Maximal non-whitespace runs, /\\S+/gu.",
    lines:
      "LF-separated logical lines; no phantom empty line after a final LF; empty text is zero lines.",
    body: "Every character after closing frontmatter delimiter LF, including the following blank line.",
    discovery:
      "name + LF + parsed YAML description + LF; not an observed host prompt. Ponytail description retains its trailing LF.",
    exclusions:
      "Full skill counts exclude license, SOURCE notice, optional Codex policy metadata, host wrappers, paths, system prompts, tools, history and retained activations. Disk totals are not prompt totals.",
    limitations:
      "Assumed activation cases for historical fixtures only; not runtime token counts, benchmarks, universal savings, identical host loading policies, or current remote catalog measurements. These selected snapshot directories contain no required external supporting Markdown/scripts/binaries. Complete supporting-file hashes are in the evidence inventory.",
  },
  sources: records.map((record) => ({
    name: `${record.author}: ${record.skillName}`,
    repository: record.repo,
    commit: record.commit,
    path: `${record.upstreamDirectory}/SKILL.md`,
    sourceUrl: record.sourceUrl,
    rawUrl: `https://raw.githubusercontent.com/${record.repo}/${record.commit}/${record.upstreamDirectory}/SKILL.md`,
    sha256: record.files.find((file) => file.installedPath === "SKILL.md")!
      .sha256,
    license: record.license,
    licenseUrl: `https://github.com/${record.repo}/blob/${record.commit}/${record.licensePath}`,
    description: record.skillDescription,
    fullFile: compact(record.measurements.fullFile),
    body: compact(record.measurements.body),
    discovery: compact(record.measurements.discoveryNameAndDescription),
  })),
  instructionsComparison: {
    sourceUrl: result.instructionsComparison.sourceUrl,
    rawUrl: `https://raw.githubusercontent.com/${ponytail.repo}/${ponytail.commit}/AGENTS.md`,
    commit: ponytail.commit,
    sha256: result.instructionsComparison.sha256,
    license: result.instructionsComparison.license,
    ...compact(result.instructionsComparison.measurements),
    installedByKits: false,
    limitation:
      "Different real upstream instructions, not byte-equivalent to the skill. Their size difference is not equivalent-content savings.",
  },
  assumedCasesUtf8Bytes: {
    allFullFilesInline: sum("fullFile"),
    discoveryOnly: discoveryBytes,
    discoveryPlusFullQuestionnaire:
      discoveryBytes + records[0]!.measurements.fullFile.utf8Bytes,
    discoveryPlusAllFullFiles: discoveryBytes + sum("fullFile"),
  },
}
await writeFile(
  resolve(root, "site/source-measurements.json"),
  `${JSON.stringify(extract, null, 2)}\n`,
)
console.log(
  `Regenerated ${records.length} historical source measurements offline.`,
)
