import { resolve } from "path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(import.meta.dirname, "src/shared"),
      "@": resolve(import.meta.dirname, "src/renderer/src"),
      electron: resolve(import.meta.dirname, "tests/electron-stub.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/main/**/*.ts", "src/shared/**/*.ts", "src/renderer/src/lib/**/*.ts"],
      // The Electron entry point and the bridge only run inside Electron; the app run exercises them.
      exclude: ["src/main/index.ts", "src/preload/**"],
      reporter: ["text-summary", "json-summary"],
    },
  },
})
