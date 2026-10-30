// The hash of a Docker build context (specs/sandbox-images R1.1): every file sorted by path, each
// as its path, NUL, its content with CRLF folded to LF, NUL, so a Windows checkout and CI agree.
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]))
}

export function contextHash(dir) {
  const h = createHash("sha256")
  const all = files(dir)
    .map((f) => ({ f, rel: relative(dir, f).split("\\").join("/") }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  for (const { f, rel } of all) {
    h.update(`${rel}\0`)
    h.update(readFileSync(f).toString("latin1").replace(/\r\n/g, "\n"), "latin1")
    h.update("\0")
  }
  return h.digest("hex")
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.stdout.write(`${contextHash(process.argv[2])}\n`)
