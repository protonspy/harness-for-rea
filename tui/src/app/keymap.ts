/*
  One key map for the whole TUI (specs/tui-shell R2.1): screens, dialogs and the prompt each push a layer of bindings
  while they are shown, and a key goes to the topmost layer that binds it — so an open dialog takes every key it binds
  before the screen under it sees them. A layer marked `modal` stops a key from reaching the layers below at all.
  Every binding has a label, so the help overlay, the hint line and the palette read the same list.
*/

/** The parts of OpenTUI's KeyEvent the map reads. */
export interface KeyLike {
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  sequence?: string
}

export interface Binding {
  /** `ctrl+p`, `escape`, `?`, `shift+tab`, `pageup` */
  key: string
  label: string
  /** returns false to leave the key to the layers below and to the focused input, as `?` does in a typed message */
  run(): void | boolean
  /** shown in the hint line under the prompt */
  hint?: boolean
}

export interface Layer {
  id: string
  /** the name the help groups this layer's keys under */
  title: string
  bindings: Binding[]
  /** keys not bound here stop at this layer rather than reaching the ones below */
  modal?: boolean
}

/** A key event as the string bindings use: modifiers in a fixed order, then the key's name. */
export function keyOf(e: KeyLike): string {
  const s = e.sequence
  // A typed symbol is its character: `?` rather than `shift+/`.
  if (s && s.length === 1 && !e.ctrl && !e.meta && s > " " && !/^[a-z0-9]$/i.test(s)) return s
  const parts = [e.ctrl && "ctrl", e.meta && "alt", e.shift && "shift", e.name].filter(Boolean)
  return parts.join("+")
}

export class Keymap {
  private layers: Layer[] = []
  private readonly listeners = new Set<() => void>()

  /** Add a layer on top; returns its removal. A layer pushed again with the same id is replaced in place. */
  push(layer: Layer): () => void {
    const at = this.layers.findIndex((l) => l.id === layer.id)
    if (at >= 0) this.layers[at] = layer
    else this.layers.push(layer)
    this.changed()
    return () => {
      const before = this.layers.length
      this.layers = this.layers.filter((l) => l !== layer)
      if (this.layers.length !== before) this.changed()
    }
  }

  /** Run the binding of the topmost layer that binds the key; whether one did. */
  dispatch(e: KeyLike): boolean {
    const key = keyOf(e)
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i]
      const b = layer.bindings.find((x) => x.key === key)
      if (b && b.run() !== false) return true
      if (layer.modal) return false
    }
    return false
  }

  /** Whether a modal layer is on top of the screen's: a dialog or an overlay is open. */
  get modal(): boolean {
    return this.layers.some((l) => l.modal)
  }

  /** The bindings a key reaches now, topmost layer first, each key once: what the help lists (R2.1). */
  active(): { title: string; bindings: Binding[] }[] {
    const seen = new Set<string>()
    const out: { title: string; bindings: Binding[] }[] = []
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i]
      const bindings = layer.bindings.filter((b) => !seen.has(b.key))
      for (const b of bindings) seen.add(b.key)
      if (bindings.length) out.push({ title: layer.title, bindings })
      if (layer.modal) break
    }
    return out
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private changed() {
    for (const fn of this.listeners) fn()
  }
}

/** A key as the help shows it: `Ctrl+P`, `Esc`, `?`. */
export function keyLabel(key: string): string {
  const names: Record<string, string> = {
    escape: "Esc",
    return: "Enter",
    pageup: "PgUp",
    pagedown: "PgDn",
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    tab: "Tab",
    space: "Space",
    home: "Home",
    end: "End",
  }
  if (key.length === 1) return key
  return key
    .split("+")
    .map((p) => names[p] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join("+")
}
