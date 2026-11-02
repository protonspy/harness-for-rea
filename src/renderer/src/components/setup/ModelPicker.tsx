import { useState } from "react"
import { groupModels, type ProviderId } from "@shared/providers"
import { Input } from "@/components/ui/input"

/*
  The orchestrator's model as a list: the provider's recommended models first — Qwen's flash models by default — then, on
  OpenRouter, the Chinese coding models it lists with tool calling, then the rest; or a model typed by name.
*/

const OTHER = "\u0000other"

export function ModelPicker({ provider, value, listed, onChange }: { provider: ProviderId; value: string; listed: string[]; onChange(model: string): void }) {
  const groups = groupModels(provider, listed)
  const known = groups.some((g) => g.models.includes(value))
  const [typing, setTyping] = useState(!known && value !== "")
  return (
    <div className="flex min-w-64 flex-1 flex-col gap-2">
      <select
        aria-label="Model"
        value={typing ? OTHER : value}
        onChange={(e) => {
          if (e.target.value === OTHER) return setTyping(true)
          setTyping(false)
          onChange(e.target.value)
        }}
        className="h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
      >
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </optgroup>
        ))}
        <option value={OTHER}>Another model, by name…</option>
      </select>
      {typing && (
        <Input
          autoFocus
          defaultValue={known ? "" : value}
          placeholder="vendor/model"
          className="font-mono"
          onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== value && onChange(e.target.value.trim())}
        />
      )}
    </div>
  )
}
