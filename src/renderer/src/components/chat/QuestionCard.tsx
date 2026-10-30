import { MessageCircleQuestion, Send } from "lucide-react"
import { useState } from "react"
import type { Answer } from "@shared/chat"
import { ErrorText } from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Textarea } from "@/components/ui/textarea"
import type { QuestionItem } from "@/lib/chat"

/* A question an agent asked, with the input its kind calls for (specs/chat R5.3, R7.4). */

const show = (a: Answer) => (typeof a === "boolean" ? (a ? "Yes" : "No") : String(a))

export function QuestionCard({ item, onAnswer }: { item: QuestionItem; onAnswer(a: Answer): Promise<void> }) {
  const { question: q } = item
  const [value, setValue] = useState<string>(q.kind === "yesno" ? "" : String(q.default))
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const answer = async (a: Answer) => {
    setBusy(true)
    setError("")
    try {
      await onAnswer(a)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const submit = () => {
    if (q.kind === "number") {
      const n = Number(value)
      if (value.trim() === "" || !Number.isFinite(n)) return setError("Enter a number.")
      return void answer(n)
    }
    void answer(value)
  }

  const who = item.agent === "specialist" ? "The specialist" : "The orchestrator"
  if (item.origin)
    return (
      <div className="ml-10 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <MessageCircleQuestion size={13} />
        <span className="text-foreground">{q.prompt}</span>
        <Badge variant={item.origin === "user" ? "ok" : "neutral"}>{show(item.answer!)}</Badge>
        {item.origin !== "user" && <span>(default, {item.origin})</span>}
      </div>
    )

  return (
    <Card className="ml-10 border-primary/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageCircleQuestion size={15} className="text-primary" />
          {who} asks
        </CardTitle>
        <Badge variant="info">{item.agent}</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div>
          <p className="text-sm font-medium whitespace-pre-wrap">{q.prompt}</p>
          <CardDescription className="mt-1">{q.reason}</CardDescription>
        </div>
        {q.kind === "choice" && (
          <RadioGroup value={value} onValueChange={setValue} aria-label={q.prompt}>
            {(q.choices ?? []).map((c) => (
              <Label key={c} className="font-normal">
                <RadioGroupItem value={c} /> {c}
              </Label>
            ))}
          </RadioGroup>
        )}
        {q.kind === "number" && <Input type="number" aria-label={q.prompt} value={value} onChange={(e) => setValue(e.target.value)} className="w-48" />}
        {q.kind === "text" && <Textarea aria-label={q.prompt} rows={3} value={value} onChange={(e) => setValue(e.target.value)} />}
        <p className="text-xs text-muted-foreground">If you do not answer in time, the agent goes on with: {show(q.default)}</p>
        <ErrorText>{error}</ErrorText>
      </CardContent>
      <CardFooter className="justify-end">
        {q.kind === "yesno" ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => answer(false)}>
              No
            </Button>
            <Button size="sm" variant="default" disabled={busy} onClick={() => answer(true)}>
              Yes
            </Button>
          </>
        ) : (
          <Button size="sm" variant="default" disabled={busy} onClick={submit}>
            <Send size={13} /> Answer
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}
