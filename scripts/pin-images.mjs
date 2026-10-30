// Pins the specialist's base image (specs/sandbox-images R1.3): resolves the tag of the current build
// context's hash on GHCR to its digest and rewrites sandbox/images.json. Run after the Images workflow
// has published the context.
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { contextHash } from "./context-hash.mjs"

const ROOT = join(import.meta.dirname, "..")
const REPOSITORY = "ghcr.io/protonspy/hfr-specialist-base"

const context = contextHash(join(ROOT, "sandbox", "specialist-base"))
const manifest = JSON.parse(
  execFileSync("docker", ["buildx", "imagetools", "inspect", `${REPOSITORY}:${context}`, "--format", "{{json .Manifest}}"], { encoding: "utf8" }),
)
if (!/^sha256:[0-9a-f]{64}$/.test(manifest.digest)) throw new Error(`No digest for ${REPOSITORY}:${context}`)
const pins = { specialistBase: { ref: `${REPOSITORY}@${manifest.digest}`, context } }
writeFileSync(join(ROOT, "sandbox", "images.json"), `${JSON.stringify(pins, null, 2)}\n`)
process.stdout.write(`${pins.specialistBase.ref}\n`)
