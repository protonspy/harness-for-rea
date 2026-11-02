/*
  The prompt's history (specs/tui-conversation R4.2): the messages sent this session, newest last. Up walks back from
  what is being typed, Down walks forward to it again, so a draft is never lost to a look at the history.
*/

export class PromptHistory {
  private readonly sent: string[] = []
  /** where Up and Down are: `sent.length` is the draft */
  private at = 0
  private draft = ""

  constructor(private readonly max = 200) {}

  /** A message sent: kept unless it repeats the last one, and the walk starts again from the draft. */
  add(text: string): void {
    const t = text.trim()
    if (t && this.sent.at(-1) !== t) this.sent.push(t)
    if (this.sent.length > this.max) this.sent.shift()
    this.at = this.sent.length
    this.draft = ""
  }

  /** The older message, or null at the oldest; `current` is kept as the draft when the walk starts. */
  prev(current: string): string | null {
    if (this.at === 0) return null
    if (this.at === this.sent.length) this.draft = current
    this.at--
    return this.sent[this.at]
  }

  /** The newer message, the draft once past the newest, or null when already at the draft. */
  next(): string | null {
    if (this.at >= this.sent.length) return null
    this.at++
    return this.at === this.sent.length ? this.draft : this.sent[this.at]
  }

  get size(): number {
    return this.sent.length
  }
}
