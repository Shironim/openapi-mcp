# Getting Started

## Installation

### Option 1: Standalone Binary (Linux, macOS, Windows)

Install a precompiled single-file executable with automatic SHA-256 checksum verification (no Node.js or Bun runtime required):

**Linux & macOS:**

```sh
curl -fsSL https://raw.githubusercontent.com/Shironim/openapi-mcp/master/scripts/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/Shironim/openapi-mcp/master/scripts/install.ps1 | iex
```

Optional environment variables supported by both installers:
- `OPENAPI_MCP_VERSION` — Install a specific release tag (for example `v0.1.0`; defaults to latest).
- `OPENAPI_MCP_INSTALL_DIR` — Override the target installation directory.
- `OPENAPI_MCP_REPO` — Override the GitHub repository slug (defaults to `Shironim/openapi-mcp`).

> **Manual Downloads:** [GitHub Releases](https://github.com/Shironim/openapi-mcp/releases) provides binaries for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and `windows-x64.exe`, along with `checksums.txt`.

### Option 2: npm or Bun (`@dimassetoid/openapi-mcp`)

Requires Node.js `>=18.20.0` or Bun `>=1.4.3`:

```sh
npm install -g @dimassetoid/openapi-mcp
# or
bun add -g @dimassetoid/openapi-mcp
```

You can also run without a global install via `npx @dimassetoid/openapi-mcp serve` or `bunx @dimassetoid/openapi-mcp serve`.

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

Or run directly from source with Bun:

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

To pin a workspace boundary and default spec file:

```sh
openapi-mcp serve --root /path/to/repo --spec api/openapi.yml
```

## Working with Multiple Specs (Monorepos)

Start the server with `--root /path/to/repo`. Read `openapi://specs/catalog` to discover conventional spec paths across projects, then pass `spec_path` per request:

- **Endpoint index:** `openapi://endpoints/index?spec_path=apps/billing/openapi.yaml`
- **Endpoint search:** `openapi://endpoints/search?spec_path=apps/billing/openapi.yaml&q=invoice`
- **Query:** `openapi_query({ spec_path: "apps/billing/openapi.yaml", code: "spec.info.title" })`

URI-encode path values when needed. Without `spec_path`, the server uses `--spec` (if configured) or checks conventional filenames (`openapi.yml`, `openapi.yaml`, `openapi.json`) in the workspace root, `api/`, and `docs/`, in that order. Per-request `spec_path` selections do not mutate the server default.

The catalog skips symlinks, `.git`, and `node_modules` (along with other common build/cache directories) and stops with a diagnostic if traversal exceeds 250,000 entries or 1 MiB of output.

---

## CLI Reference

```text
openapi-mcp <command> [options]
```

| Command | Description |
| --- | --- |
| `openapi-mcp serve [--root <dir>] [--spec <path>]` | Start the MCP server over `stdio` |
| `openapi-mcp check [--root <dir>] [--spec <path>] [--strict] [--json]` | Validate an OpenAPI spec and report contract issues (exits `1` on errors, or warnings with `--strict`) |
| `openapi-mcp diff <base> <target> [--root <dir>] [--fail-on-breaking] [--json]` | Compare two local specs for breaking changes (exits `1` on breaking changes with `--fail-on-breaking`) |
| `openapi-mcp` (piped stdin) | Auto-start the MCP server over `stdio` |
| `openapi-mcp -h \| --help` | Show help message (written to `stderr`) |
| `openapi-mcp -v \| --version` | Show version number (written to `stderr`) |

Startup/shutdown logs, `--help`, and `--version` are written to `stderr`, keeping `stdout` clean for MCP JSON-RPC frames (`serve`) and machine-readable reports (`check`, `diff`).

---

## Agent Skill

Copy [skills/use-openapi-mcp/SKILL.md](../../skills/use-openapi-mcp/SKILL.md) into `.agents/skills/use-openapi-mcp/SKILL.md` (or your global agent skills directory) to provide AI coding agents with a concise routing guide for MCP resources, `helpers.*`, and `openapi_diff`.

## Inspecting an API Workflow

1. **Select a spec:** In a monorepo, read `openapi://specs/catalog` and pass the chosen `spec_path` to subsequent calls.
2. **Locate an operation:** Read `openapi://endpoints/index` or query `openapi://endpoints/search?q=orders&limit=20` (follow `nextUri` for additional pages).
3. **Inspect the contract:** Call `openapi_query` with `helpers.op('POST', '/orders')` or `helpers.example('POST', '/orders', '422')` to inspect merged parameters, auth, and response schemas.

Four built-in MCP prompts (`sync-frontend-api`, `audit-error-contracts`, `review-breaking-changes`, and `generate-test-fixtures`) provide step-by-step agent workflows.

---

## Development & Verification

```sh
bun test                     # Run engine unit tests and InMemoryTransport MCP contract tests
bun run typecheck            # Run TypeScript strict type checking (tsc --noEmit)
bun run build                # Emit npm JavaScript and type declarations to dist/
bun run compile:all          # Build standalone binaries into release/
sh scripts/verify-package.sh # Pack, install, typecheck a TypeScript consumer, and smoke-test stdio
```
