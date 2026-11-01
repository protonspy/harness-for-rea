import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs"
import { basename, extname, join } from "node:path"
import type { TargetInfo, TargetKind } from "@shared/types"

/*
  What a project's target is (specs/projects R1.4), told from its extension and its first bytes, and what the
  specialist works on it with (adr:0018-make-rea-native-to-the-specialist). Detection is a hint for the user and the
  orchestrator: the specialist routes the target itself.
*/

const LABELS: Record<TargetKind, string> = {
  android: "Android package",
  elf: "ELF binary",
  pe: "Windows PE binary",
  macho: "Mach-O binary",
  dotnet: ".NET assembly",
  electron: "Electron application",
  javascript: "JavaScript application",
  archive: "Archive",
  firmware: "Firmware or raw image",
  folder: "Folder",
  file: "File",
}

const ENGINES: Record<TargetKind, string[]> = {
  android: ["REA Android tools", "JADX", "Apktool", "Ghidra for native libraries"],
  elf: ["REA native tools", "Ghidra"],
  pe: ["REA native tools", "Ghidra"],
  macho: ["REA native tools", "Ghidra"],
  dotnet: ["REA managed .NET tools"],
  electron: ["REA JavaScript and Electron tools"],
  javascript: ["REA JavaScript tools"],
  archive: ["REA artifact inventory"],
  firmware: ["REA firmware tools", "Ghidra"],
  folder: ["REA routes each file it finds"],
  file: ["REA routes the file by its content"],
}

const ANDROID = new Set([".apk", ".xapk", ".apks", ".aab", ".apkm"])
const ARCHIVE = new Set([".zip", ".jar", ".ipa", ".tar", ".gz", ".tgz", ".xz", ".7z", ".rar", ".zst"])
const FIRMWARE = new Set([".bin", ".img", ".fw", ".hex", ".dfu", ".rom", ".elf32"])
const JAVASCRIPT = new Set([".js", ".mjs", ".cjs"])

/** The first bytes of a file, at most `n`. */
function head(path: string, n = 4096): Buffer {
  const fd = openSync(path, "r")
  try {
    const buf = Buffer.alloc(n)
    return buf.subarray(0, readSync(fd, buf, 0, n, 0))
  } finally {
    closeSync(fd)
  }
}

/** Whether a PE image declares a CLR runtime header: data directory 14 of its optional header is set. */
export function isDotNet(b: Buffer): boolean {
  if (b.length < 0x40 || b.toString("latin1", 0, 2) !== "MZ") return false
  const pe = b.readUInt32LE(0x3c)
  if (pe + 24 > b.length || b.toString("latin1", pe, pe + 4) !== "PE\0\0") return false
  const opt = pe + 24
  const magic = b.readUInt16LE(opt)
  const dirs = opt + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : NaN)
  const clr = dirs + 14 * 8
  if (!Number.isFinite(clr) || clr + 8 > b.length) return false
  return b.readUInt32LE(clr) !== 0 && b.readUInt32LE(clr + 4) !== 0
}

/** A target's kind from its first bytes and its extension. */
export function kindOf(name: string, b: Buffer): TargetKind {
  const ext = extname(name).toLowerCase()
  const magic = b.subarray(0, 4).toString("hex")
  if (ANDROID.has(ext)) return "android"
  if (ext === ".asar") return "electron"
  if (b.toString("latin1", 0, 4) === "\x7fELF") return "elf"
  if (b.toString("latin1", 0, 2) === "MZ") return isDotNet(b) ? "dotnet" : "pe"
  if (["feedface", "feedfacf", "cefaedfe", "cffaedfe"].includes(magic) || (magic === "cafebabe" && ext !== ".class")) return "macho"
  if (JAVASCRIPT.has(ext)) return "javascript"
  if (ARCHIVE.has(ext) || magic === "504b0304" || magic.startsWith("1f8b") || magic === "fd377a58" || magic === "377abcaf" || magic === "52617221")
    return "archive"
  if (FIRMWARE.has(ext)) return "firmware"
  return "file"
}

/** A folder holding an Electron or JavaScript application, told by its package files. */
function folderKind(dir: string): TargetKind {
  if (existsSync(join(dir, "resources", "app.asar")) || existsSync(join(dir, "app.asar"))) return "electron"
  if (existsSync(join(dir, "package.json"))) return "javascript"
  return "folder"
}

/** What the target at `path` is; throws when it cannot be read (specs/projects R1.7). */
export function detectTarget(path: string): TargetInfo {
  const st = statSync(path)
  if (st.isDirectory()) {
    const kind = folderKind(path)
    return { path, kind, isFile: false, size: 0, label: LABELS[kind], engines: ENGINES[kind] }
  }
  if (!st.isFile()) throw new Error(`${basename(path)} is neither a file nor a folder.`)
  const kind = kindOf(path, head(path))
  return { path, kind, isFile: true, size: st.size, label: LABELS[kind], engines: ENGINES[kind] }
}
