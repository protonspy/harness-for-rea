import { cn } from "@/lib/cn"

/** Agent text as written, wrapped, with no HTML interpretation. */
export default function Prose({ text, className }: { text: string; className?: string }) {
  return <div className={cn("text-sm leading-relaxed whitespace-pre-wrap break-words", className)}>{text}</div>
}
