import { CircleStop, Loader2, Play, SendHorizontal } from "lucide-react"
import { useState, type KeyboardEvent } from "react"
import type { TaskState } from "@shared/types"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { canSend, canStop, turnLabel } from "@/lib/chat"
import { cn } from "@/lib/cn"

/*
  The turn's state and the message box under the conversation (specs/chat R7.2, R7.5): open while a
  turn runs or waits, with stop while one is under way and continue once it is stopped.
*/

export function Composer({
  state,
  waitingOn,
  onSend,
  onStop,
  onContinue,
}: {
  state: TaskState
  waitingOn: number
  onSend(text: string): Promise<boolean>
  onStop(): void
  onContinue(): void
}) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const open = canSend(state)

  const send = async () => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    if (await onSend(t)) setText("")
    setBusy(false)
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div className="border-t bg-card/60 px-6 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs">
        {canStop(state) && <Loader2 size={13} className="animate-spin text-primary" />}
        <span
          className={cn(
            state === "awaiting-user" ? "font-medium text-success" : state === "waiting" || state === "stopped" ? "text-warning" : "text-muted-foreground",
          )}
        >
          {turnLabel(state, waitingOn)}
        </span>
        <div className="ml-auto flex gap-2">
          {canStop(state) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" variant="destructive" onClick={onStop}>
                  <CircleStop size={13} /> Stop
                </Button>
              </TooltipTrigger>
              <TooltipContent>Stop the turn. The conversation stays open and the turn can be continued.</TooltipContent>
            </Tooltip>
          )}
          {state === "stopped" && (
            <Button size="sm" variant="default" onClick={onContinue}>
              <Play size={13} /> Continue
            </Button>
          )}
        </div>
      </div>
      <div className="flex items-end gap-2">
        <Textarea
          aria-label="Message"
          rows={2}
          disabled={!open}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          className="max-h-48 min-h-[44px] resize-none"
          placeholder={
            !open
              ? "Retry the task to start a new conversation."
              : state === "awaiting-user"
                ? "Reply to the orchestrator…"
                : "Add a message while it works… (Enter to send, Shift+Enter for a new line)"
          }
        />
        <Button size="icon" variant="default" aria-label="Send" disabled={!open || busy || !text.trim()} onClick={send}>
          <SendHorizontal size={16} />
        </Button>
      </div>
    </div>
  )
}
