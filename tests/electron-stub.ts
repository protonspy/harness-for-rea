// Stand-in for the electron module when main-process code runs under plain Node in tests.
// `safeStorage` prefixes a marker so a test can tell what went through encryption; `stub` switches it off.

export const stub = { encryption: true }

export const safeStorage = {
  isEncryptionAvailable: () => stub.encryption,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ""),
}

export const app = { getVersion: () => "test", getPath: () => ".", isPackaged: false, getAppPath: () => process.cwd() }
export const shell = { openExternal: async () => undefined }
export const ipcMain = { handle: () => undefined }
export default { safeStorage, app, shell, ipcMain }
