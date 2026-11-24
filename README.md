# openapi-mcp

> **Local Code Mode OpenAPI server, CLI, and contract engine for AI coding agents and CI.**

[![npm version](https://img.shields.io/npm/v/@dimassetoid/openapi-mcp)](https://www.npmjs.com/package/@dimassetoid/openapi-mcp)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh)
[![Protocol: Model Context Protocol](https://img.shields.io/badge/Protocol-MCP-green)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

`openapi-mcp` is a local Model Context Protocol (MCP) server, CLI, and reusable TypeScript engine for OpenAPI 3.0/3.1 and Swagger 2.0 specifications. It lets AI coding agents and CI pipelines inspect endpoints, schemas, and contract diffs without loading entire specification files into context.

## Key Capabilities

- **Monorepo Spec Discovery (`openapi://specs/catalog`)** — Scans workspaces for OpenAPI entry files while skipping symlinks, unreadable directories (`EACCES`/`EPERM`), and build or dependency folders (`node_modules`, `vendor`, `dist`, `.git`, etc.).
- **Indexed Endpoints & Paginated Search (`openapi://endpoints/index`, `openapi://endpoints/search`)** — Summarizes HTTP methods, paths, `2xx`/`4xx`/`5xx` status codes, error bodies, auth schemes, deprecation flags, and `{ file, line }` source locations, soft-capped at `64 KB`.
- **Schema Index & Reverse References (`openapi://schemas/index`, `openapi://schemas/search`)** — Lists `components.schemas` / `definitions` with required fields, properties, `unusedSchemas`, source locations, and reverse `usedBy` operation references.
- **Single-Pass Contract Diagnostics (`openapi://spec/diagnostics`, `openapi-mcp check`)** — Reports broken `$ref`s, duplicate `operationId`s, undeclared path parameters, unknown security schemes, and missing error contracts in one pass.
- **Sandboxed Query Engine (`openapi_query`)** — Runs read-only JavaScript in QuickJS WASM against frozen `spec` and built-in `helpers` (`helpers.op`, `helpers.example`, `helpers.schemaRefs`).
- **Semantic Contract Diff (`openapi_diff`, `openapi-mcp diff`)** — Compares two local specifications and classifies changes into `breaking` and `nonBreaking`.
- **MCP Prompts & Agent Skill** — Ships four guided prompts (`sync-frontend-api`, `audit-error-contracts`, `review-breaking-changes`, `generate-test-fixtures`) and a portable Agent Skill at [skills/use-openapi-mcp/SKILL.md](skills/use-openapi-mcp/SKILL.md).

## Installation

### Standalone Binary (Recommended)

Install precompiled single-file binaries for Linux, macOS, or Windows with SHA-256 verification (no Node.js or Bun required):

**Linux & macOS:**

```sh
curl -fsSL https://raw.githubusercontent.com/Shironim/openapi-mcp/master/scripts/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/Shironim/openapi-mcp/master/scripts/install.ps1 | iex
```

You can also download archives directly from [GitHub Releases](https://github.com/Shironim/openapi-mcp/releases) (`openapi-mcp-linux-x64`, `openapi-mcp-linux-arm64`, `openapi-mcp-darwin-x64`, `openapi-mcp-darwin-arm64`, `openapi-mcp-windows-x64.exe`, and `checksums.txt`).

### Via npm or Bun

Requires Node.js `>=18.20.0` or Bun `>=1.4.3`:

```sh
npm install -g @dimassetoid/openapi-mcp
# or
bun add -g @dimassetoid/openapi-mcp
```

Or run without global installation:

```sh
npx @dimassetoid/openapi-mcp serve
# or
bunx @dimassetoid/openapi-mcp serve
```

## Quick Start

### MCP Client Setup

Add `openapi-mcp` to your MCP client configuration (for example `.mcp.json`):

```json
{
  "mcpServers": {
    "openapi-mcp": {
      "command": "openapi-mcp",
      "args": ["serve", "--root", "/path/to/repo"]
    }
  }
}
```

Once connected, ask your agent:

> Which endpoint creates an order, what does its `422` validation schema look like, and what is a valid example payload?

### CI & Local CLI

Run contract diagnostics or breaking-change checks directly in your terminal or CI pipeline:

```sh
openapi-mcp check --root . --spec openapi.yml --strict
openapi-mcp diff openapi.yml openapi-v2.yml --fail-on-breaking
```

## CLI Reference

```text
openapi-mcp <command> [options]
```

| Command | Description |
| --- | --- |
| `serve` | Start the MCP server over `stdio` (also starts automatically when stdin is piped) |
| `check` | Validate an OpenAPI spec and report contract issues |
| `diff <base> <target>` | Compare two local OpenAPI specs for breaking changes |

| Option | Description |
| --- | --- |
| `--root <dir>` | Workspace root directory (defaults to current directory) |
| `--spec <path>` | Path to OpenAPI spec file (`serve`, `check`) |
| `--strict` | Exit with code `1` if warnings are found (`check`) |
| `--fail-on-breaking` | Exit with code `1` if breaking changes are found (`diff`) |
| `--json` | Output results as JSON (`check`, `diff`) |
| `-h, --help` | Show help message (written to `stderr`) |
| `-v, --version` | Show version number (written to `stderr`) |

## Documentation

- [Feature Overview & Architecture](docs/feature/README.md)
- [Getting Started, MCP Setup & CLI Reference](docs/feature/getting-started.md)
- [Specification Loader, `$ref` Resolution & Source Mapping](docs/feature/spec-loader.md)
- [Indexes, Diagnostics & Workflow Prompts](docs/feature/index-and-prompts.md)
- [Code Mode Query (`openapi_query`) & Semantic Diff (`openapi_diff`)](docs/feature/openapi-query.md)
- [Agent Skill Playbook (`use-openapi-mcp`)](skills/use-openapi-mcp/SKILL.md)

## Development

```sh
bun install
bun run typecheck
bun test
bun run build
bun run compile:all          # Build standalone binaries into release/
sh scripts/verify-package.sh # Verify npm tarball, TypeScript consumer, and stdio smoke test
```

## License

[MIT](LICENSE)
