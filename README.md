# openapi-mcp

> **Local OpenAPI contract inspection for AI coding agents.**

[![npm version](https://img.shields.io/npm/v/@dimassetoid/openapi-mcp)](https://www.npmjs.com/package/@dimassetoid/openapi-mcp)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh)
[![Protocol: Model Context Protocol](https://img.shields.io/badge/Protocol-MCP-green)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

openapi-mcp is a local MCP server that helps coding agents work with the APIs documented in your repository. It reads OpenAPI files in YAML or JSON, follows local references across files, and builds an index of operations. An agent can find an endpoint and inspect the part of its contract needed for a change.

## What It Does

- **Service discovery.** The workspace catalog lists OpenAPI files across a monorepo. If Billing and Sales both define `GET /invoices`, the agent can select Billing’s specification for its request.
- **Endpoint search.** The endpoint index shows methods, paths, summaries, and declared response statuses. Agents can search by text, tag, or operation ID and page through matching operations.
- **Request and response inspection (`openapi_query`).** This read-only tool lets an agent inspect parameters, request bodies, and response schemas. For example, before changing a checkout form, it can look up which fields the orders API declares in its `422` response.
- **Integration review.** The `sync-frontend-api` prompt guides an agent through comparing a frontend caller with the documented contract. The `audit-error-contracts` prompt guides it through checking which error responses declare a status and which also describe the response body.

## Installation

Install the package with npm:

```sh
npm install -g @dimassetoid/openapi-mcp
```

A standalone executable is also available for Linux, macOS, and Windows. [Standalone and Bun installation instructions](docs/feature/getting-started.md#installation)

## Quick Start

Configure your MCP client to run `openapi-mcp serve --root /path/to/repo`. Replace the path with the repository containing your OpenAPI files. Once connected, try asking your agent:

> Which endpoint creates an order, and what does its specification say happens when validation fails?

For a monorepo, include the service name in your question so the agent can select its spec. [MCP client configuration](docs/feature/getting-started.md#mcp-client-configuration) · [Monorepo setup](docs/feature/getting-started.md#work-with-multiple-specs)

## CLI Reference

| Command | Purpose |
|---|---|
| `openapi-mcp serve` | Start the MCP server in the current workspace. |
| `openapi-mcp serve --root <dir> --spec <path>` | Set the workspace and default specification. |
| `openapi-mcp --help` | Show usage and options. |
| `openapi-mcp --version` | Print the installed version. |

## Documentation

- [Feature overview and architecture](docs/feature/README.md)
- [Spec selection and local references](docs/feature/spec-loader.md)
- [Endpoint search, response summaries, and review prompts](docs/feature/index-and-prompts.md)
- [Query examples and output limits](docs/feature/openapi-query.md)

## Development

```bash
# Clone the repository and install dependencies
git clone https://github.com/Shironim/openapi-mcp.git
cd openapi-mcp
bun install

# Run tests, check types, and build the package
bun test
bun run typecheck
bun run build
```

[Standalone builds and package verification](docs/feature/getting-started.md#development--testing)

## License

[MIT](LICENSE)
