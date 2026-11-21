# openapi-mcp: Implemented Features

This directory documents the implemented behavior, MCP contracts, security boundaries, and known limits in this checkout.

`openapi-mcp` separates its reusable OpenAPI engine ([src/engine/](../../src/engine/index.ts)) from the MCP server layer ([src/mcp/server.ts](../../src/mcp/server.ts)) and stdio CLI entrypoint ([src/index.ts](../../src/index.ts)).

---

## Feature Documents

| Document | Contents |
|---|---|
| [Installation and setup](getting-started.md) | Install the server, connect a client, and select a service in a monorepo |
| [Spec Loader & `$ref` Resolver](spec-loader.md) | Candidate discovery, YAML/JSON parsing, multi-file `$ref`, cycle guards, `realpath` sandboxing, and freshness cache |
| [Code Mode Query (`openapi_query`)](openapi-query.md) | Tool schema, `ToolAnnotations`, QuickJS guest isolation, deadline, memory limits, and result-text budget |
| [Endpoint Index & Prompts](index-and-prompts.md) | Workspace catalog, endpoint index, paginated search, and workflow prompts |

---

## Architecture Overview

```text
src/
├── engine/                  # Reusable OpenAPI engine library
│   ├── spec-loader.ts       # YAML/JSON parser, $ref resolver, security guards, freshness cache
│   ├── spec-catalog.ts      # Recursive workspace filename discovery
│   ├── index-builder.ts     # Endpoint summaries, search filters, and pagination
│   ├── query-sandbox.ts     # JavaScript parsing and bounded QuickJS execution
│   ├── budget.ts            # Result-text budget and recovery diagnostics
│   └── index.ts             # Public engine exports
├── mcp/
│   └── server.ts            # MCP Server (instructions, resource, prompts, openapi_query tool)
└── index.ts                 # CLI & stdio transport lifecycle (SIGINT, SIGTERM, stdin close)
```

---

## Shared execution paths

- The CLI passes workspace configuration to the MCP adapter. Index, search, and query use the same loader and accept a request-local `spec_path`. The catalog lists matching filenames without parsing the files.
- Discovery, reference expansion, and cache freshness share path resolution and a per-load file snapshot. The loader hands the index a frozen object and the evaluator the cached JSON representation of that object.
- The MCP tool schema is generated from its runtime argument validator. Object results use the same guest-serialized JSON for content and structured content. The library and MCP adapter call the same evaluator.
- The npm root and engine exports share one emitted module tree and cache. Standalone binaries use the same TypeScript source, with release output kept in `release/`.

## MCP Primitives Summary

| Primitive | Name / URI | Purpose |
|---|---|---|
| Resource | `openapi://endpoints/index` | `application/json` compact list of `METHOD /path — summary — [statusCodes]` |
| Resource | `openapi://specs/catalog` | Sorted spec paths relative to the workspace root |
| Resource template | `openapi://endpoints/index{?spec_path}` | Full index for the selected spec |
| Resource template | `openapi://endpoints/search{?q,tag,operationId,offset,limit,spec_path}` | Filtered page of operations from one spec |
| Tool | `openapi_query` | Read-only JS query execution against deep-frozen `spec` (`readOnlyHint: true`) |
| Prompt | `sync-frontend-api` | Guides index check → request + `2xx` + `4xx`/`5xx` query → frontend sync |
| Prompt | `audit-error-contracts` | Guides completeness and schema consistency audit of `4xx`/`5xx` responses |

---

## Verification Scope

- Unit tests in [tests/engine.test.ts](../../tests/engine.test.ts) verify circular `$ref` handling, multi-file `$ref` resolution, path traversal and symlink rejection, cache invalidation, QuickJS query behavior and interrupt handling, endpoint indexing, and byte-budget enforcement.
- Protocol contract tests in [tests/mcp-contract.test.ts](../../tests/mcp-contract.test.ts) cover monorepo selection, search pagination, missing-reference recovery, `initialize`, `tools/list` annotations, `resources/list` + `resources/read`, `prompts/list` + `prompts/get` anti-prompt-drift checks, `openapi_query` execution over `InMemoryTransport`, and `stdio` lifecycle behavior (`--help`, `--version`, piped JSON-RPC `initialize`, and `stdin` close shutdown).
