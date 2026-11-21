# Set up openapi-mcp

## Installation

### Option 1: Standalone Binary (Linux, macOS, Windows)

Install precompiled single-file executables without requiring Bun or Node.js:

**Linux & macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/Shironim/openapi-mcp/master/scripts/install.sh | sh
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/Shironim/openapi-mcp/master/scripts/install.ps1 | iex
```

> **Manual Downloads:** The GitHub release workflow builds and smoke-tests standalone binaries via `.github/workflows/release.yml` (`openapi-mcp-linux-x64`, `openapi-mcp-linux-arm64`, `openapi-mcp-darwin-x64`, `openapi-mcp-darwin-arm64`, `openapi-mcp-windows-x64.exe`, plus `checksums.txt`).

### Option 2: Via npm / Bun (`@dimassetoid/openapi-mcp`)

The npm package requires Node.js 18.20 or later, or Bun 1.4.3 or later.

```bash
bun add -g @dimassetoid/openapi-mcp
# or with npm:
npm install -g @dimassetoid/openapi-mcp
```

You can also invoke it without global installation via `bunx @dimassetoid/openapi-mcp serve` or `npx @dimassetoid/openapi-mcp serve`.

---

## MCP Client Configuration

Add `openapi-mcp` to `.mcp.json` or your MCP client configuration:

```json
{
  "mcpServers": {
    "openapi-mcp": {
      "command": "openapi-mcp",
      "args": ["serve"]
    }
  }
}
```

Or run directly with Bun:

```json
{
  "mcpServers": {
    "openapi-mcp": {
      "command": "bun",
      "args": ["run", "/path/to/openapi-mcp/src/index.ts", "serve"]
    }
  }
}
```

You can set the workspace boundary and the default spec file:

```bash
openapi-mcp serve --root /path/to/repo --spec api/openapi.yml
```

## Work with multiple specs

For a monorepo, start the server with `--root /path/to/repo`. Read `openapi://specs/catalog` to list conventional spec paths across projects. Select one path per request, for example:

- Index: `openapi://endpoints/index?spec_path=apps/billing/openapi.yaml`
- Search: `openapi://endpoints/search?spec_path=apps/billing/openapi.yaml&q=invoice`
- Query: `openapi_query({ spec_path: "apps/billing/openapi.yaml", code: "spec.info.title" })`

URI-encode path values when needed. Without a selector, the server uses its configured spec or checks the conventional filenames in the root, `api/`, and `docs/`, in that order. Selections leave the default unchanged. The catalog skips symlinks, `.git`, and `node_modules`; it stops with a diagnostic above 250,000 visited entries or 1 MiB of output. A custom filename can still be selected directly.

## CLI Reference

| Command | Description |
|---|---|
| `openapi-mcp serve [--root <dir>] [--spec <path>]` | Start the MCP server over `stdio` |
| `openapi-mcp` (piped stdin / `!isTTY`) | Auto-start the MCP server over `stdio` |
| `openapi-mcp --help` / `-h` | Show usage help (written to `stderr`) |
| `openapi-mcp --version` / `-v` | Show version (`0.1.0`, written to `stderr`) |

The CLI writes startup and shutdown messages to `stderr`. It uses `stdout` for MCP protocol messages, including tool and resource responses.

## Inspect an API

1. **Choose a spec.** In a monorepo, read `openapi://specs/catalog` to find conventional spec filenames. Pass the chosen `spec_path` to subsequent requests.
2. **Find an operation.** Read `openapi://endpoints/index` for the full index or `openapi://endpoints/search?q=orders&limit=20` for a filtered page. Follow `nextUri` for more results.
3. **Inspect the contract.** Call the read-only tool `openapi_query` to read parameters, request bodies, or response schemas. For example, `spec.paths['/orders']?.post?.responses?.['422']` reads the declared validation response.

The two workflow prompts, `sync-frontend-api` and `audit-error-contracts`, return instructions your agent can follow.

## Development & Testing

```bash
bun test            # Run engine unit tests and InMemoryTransport MCP contract tests
bun run typecheck   # Run TypeScript strict type checking (tsc --noEmit)
bun run build       # Emit npm JavaScript and declarations to dist/
bun run compile:all # Build standalone binaries to release/
sh scripts/verify-package.sh # Pack, install, compile a TypeScript consumer, and smoke-test stdio
```
