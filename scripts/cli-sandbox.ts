// The parts of sandbox/ the CLI/TUI reads at run time, which scripts/build-cli.ts copies into the npm package and
// beside each binary (specs/release R1.3): the specialist's Dockerfile folder, the integrations' MCP server a
// delegation copies into its run directory, and Cheat Engine's bridge its checks and install read.
export const CLI_SANDBOX = ["specialist", "mcp", "cheat-engine"] as const
