/** A file imported as its text, as electron-vite and Vitest both resolve `?raw`. */
declare module "*?raw" {
  const text: string
  export default text
}
