import { expect, test } from "bun:test"
import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { testRender } from "@opentui/react/test-utils"

/*
  The smoke screen test (plans/tui-revamp 1.5): OpenTUI's test renderer starts under Bun, draws a React tree and
  delivers a key to it, so the job fails when the renderer or its native library does not load.
*/

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false

function Counter() {
  const [n, setN] = useState(0)
  useKeyboard((k) => k.name === "up" && setN((x) => x + 1))
  return <text>{`count ${n}`}</text>
}

test("OpenTUI's test renderer starts, draws a React tree and delivers a key", async () => {
  const t = await testRender(<Counter />, { width: 40, height: 5 })
  await t.renderOnce()
  expect(t.captureCharFrame()).toContain("count 0")
  t.mockInput.pressArrow("up")
  for (let i = 0; i < 100 && !t.captureCharFrame().includes("count 1"); i++) {
    await Bun.sleep(10)
    await t.renderOnce()
  }
  expect(t.captureCharFrame()).toContain("count 1")
  await t.dispose()
})
