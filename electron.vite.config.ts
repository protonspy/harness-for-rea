import { resolve } from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "electron-vite"
import type { Plugin } from "vite"
import { contentSecurityPolicy } from "./src/main/csp"

/** The built page carries its CSP as a meta tag: a file:// page gets no response headers. */
const csp: Plugin = {
  name: "hfr-csp",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace(
      "<head>",
      `<head>
    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy()}" />`,
    ),
}

const shared = resolve(__dirname, "src/shared")

export default defineConfig({
  main: {
    resolve: { alias: { "@shared": shared } },
    build: { rollupOptions: { external: ["node:sqlite"] } },
  },
  preload: {
    resolve: { alias: { "@shared": shared } },
  },
  renderer: {
    plugins: [react(), tailwindcss(), csp],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
        "@shared": shared,
      },
    },
  },
})
