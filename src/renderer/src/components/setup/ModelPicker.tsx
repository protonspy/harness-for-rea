import { useState } from "react"
import { groupModels, type ProviderId } from "@shared/providers"
import { getModelPricing, formatModelPricingShort, formatModelPricingDetails } from "@shared/pricing"
import type { ChatGPTModelOption } from "@shared/types"
import { Input } from "@/components/ui/input"

/*
  The orchestrator's or specialist's model choice: for ChatGPT, strictly the authenticated account's catalog
  with displayName and server order; for other providers, recommended models first, Chinese coding models on
  OpenRouter, or a model typed by name.
*/

const OTHER = "\u0000other"

function ChatGPTModelPicker({
  value,
  listed,
  loading = false,
  emptyNote,
  onChange,
}: {
  value: string
  listed: readonly (string | ChatGPTModelOption)[]
  loading?: boolean
  emptyNote?: string
  onChange(model: string): void
}) {
  const chatGPTOptions: ChatGPTModelOption[] = listed.map((m) => (typeof m === "string" ? { slug: m, displayName: m } : m))
  if (loading) {
    return (
      <div className="flex min-w-64 flex-1 flex-col gap-2">
        <select
          aria-label="Model"
          disabled
          value=""
          className="h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm opacity-60 outline-none"
        >
          <option value="">Loading models from ChatGPT plan…</option>
        </select>
      </div>
    )
  }

  if (chatGPTOptions.length === 0) {
    return (
      <div className="flex min-w-64 flex-1 flex-col gap-2">
        <select
          aria-label="Model"
          disabled
          value=""
          className="h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm opacity-60 outline-none"
        >
          <option value="">{emptyNote || "No models available for this account"}</option>
        </select>
      </div>
    )
  }

  return (
    <div className="flex min-w-64 flex-1 flex-col gap-2">
      <select
        aria-label="Model"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
      >
        {chatGPTOptions.map((opt) => (
          <option key={opt.slug} value={opt.slug}>
            {opt.displayName}
          </option>
        ))}
      </select>
    </div>
  )
}

function StandardModelPicker({
  provider,
  value,
  listed,
  onChange,
}: {
  provider: ProviderId
  value: string
  listed: readonly (string | ChatGPTModelOption)[]
  onChange(model: string): void
}) {
  const stringList = listed.map((m) => (typeof m === "string" ? m : m.slug))
  const groups = groupModels(provider, stringList)
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
            {g.models.map((m) => {
              const pricing = getModelPricing(provider, m)
              const label = pricing ? `${m} ${formatModelPricingShort(pricing)}` : m
              return (
                <option key={m} value={m}>
                  {label}
                </option>
              )
            })}
          </optgroup>
        ))}
        <option value={OTHER}>Another model, by name…</option>
      </select>
      {(() => {
        const pricing = getModelPricing(provider, value)
        if (!pricing) return null
        return <p className="text-xs text-muted-foreground font-mono">{formatModelPricingDetails(pricing)}</p>
      })()}
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

export function ModelPicker(props: {
  provider: ProviderId
  value: string
  listed: readonly (string | ChatGPTModelOption)[]
  loading?: boolean
  emptyNote?: string
  onChange(model: string): void
}) {
  if (props.provider === "chatgpt") {
    return <ChatGPTModelPicker {...props} />
  }
  return <StandardModelPicker {...props} />
}
