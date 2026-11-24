# openapi-mcp: Implemented Features

This directory documents the implemented behavior, MCP contracts, security boundaries, and known limits in this checkout.

`openapi-mcp` separates its reusable OpenAPI engine ([src/engine/](../../src/engine/index.ts)) from the MCP server layer ([src/mcp/server.ts](../../src/mcp/server.ts)) and CLI/stdio entrypoint ([src/index.ts](../../src/index.ts)).

---

## Feature Documents

| Document | Contents |
|---|---|
| [Installation and setup](getting-started.md) | Install the server, connect an MCP client, configure monorepos, and run CLI `check`/`diff` |
| [Spec Loader & `$ref` Resolver](spec-loader.md) | Candidate discovery, single-pass YAML/JSON source mapping, multi-file `$ref`, cycle guards, reverse usage tracking, `realpath` sandboxing, and freshness cache |
| [Code Mode Query & Diff (`openapi_query`, `openapi_diff`)](openapi-query.md) | Tool schemas, `ToolAnnotations`, QuickJS guest isolation, built-in `helpers` (`op`, `example`, `schemaRefs`), timeouts, byte budget, and semantic contract diffing |
| [Indexes, Diagnostics & Prompts](index-and-prompts.md) | Resilient workspace catalog, endpoint/schema indexes, paginated search, multi-issue diagnostics, and workflow prompts |

---

## Architecture Overview

```text
src/
├── engine/                   # Reusable OpenAPI engine library (@dimassetoid/openapi-mcp/engine)
│   ├── source-map.ts         # Single-pass yaml v2 parseDocument + LineCounter source locations
│   ├── spec-loader.ts        # $ref resolver, security guards, reverse schema usage graph, LRU cache
│   ├── spec-catalog.ts       # Resilient workspace discovery (EACCES-safe + default ignore dirs)
│   ├── index-builder.ts      # Endpoint summaries (security, deprecated, sourceLocation) & search
│   ├── schema-index.ts       # Component schema index, reverse references (usedBy), and search
│   ├── example-generator.ts  # Deterministic OpenAPI 3.0/3.1 sample generator & merged operation helper
│   ├── spec-diagnostics.ts   # Non-throwing multi-issue contract & $ref validator
│   ├── spec-diff.ts          # Semantic breaking vs non-breaking OpenAPI diff engine
│   ├── query-sandbox.ts      # Acorn AST checks and bounded QuickJS WASM execution + frozen helpers
│   ├── budget.ts             # UTF-8 result-text budget and narrowing diagnostics
│   └── index.ts              # Public engine exports
├── mcp/
│   ├── prompts.ts            # 4 MCP prompts & renderer (sync, audit, diff, fixtures)
│   ├── resources.ts          # Catalog, endpoint/schema indexes, paginated search, diagnostics
│   └── server.ts             # MCP Server assembly (instructions, tools, error mapping)
└── index.ts                  # CLI (`serve`, `check`, `diff`) & stdio transport lifecycle
skills/
└── use-openapi-mcp/SKILL.md  # Portable AI Agent Skill playbook
```

---

## MCP Primitives Summary

| Primitive | Name / URI | Purpose |
|---|---|---|
| Resource | `openapi://specs/catalog` | Sorted spec paths relative to workspace root (with `skippedDirs` when unreadable dirs are encountered) |
| Resource | `openapi://endpoints/index` | Compact endpoint index with `2xx`/`4xx`/`5xx`, `errorBodies`, `security`, `deprecated`, `tags`, and `sourceLocation` (64 KB soft cap) |
| Resource | `openapi://schemas/index` | Compact `components.schemas` / `definitions` index with `required`, `properties`, `unusedSchemas`, `sourceLocation`, and `usedBy` (64 KB soft cap) |
| Resource | `openapi://spec/diagnostics` | Multi-issue single-pass report of broken `$ref`s, duplicate `operationId`s, undeclared path params, unknown security schemes, and missing error contracts |
| Resource templates | `openapi://endpoints/search{?q,tag,method,pathPrefix,operationId,missingErrorContracts,offset,limit,spec_path}`<br>`openapi://endpoints/index{?spec_path}`<br>`openapi://schemas/search{?q,usedByPath,unusedOnly,offset,limit,spec_path}`<br>`openapi://schemas/index{?spec_path}`<br>`openapi://spec/diagnostics{?spec_path}` | Filtered pagination and monorepo `spec_path` selection |
| Tool | `openapi_query` | Read-only QuickJS query against frozen `spec` and `helpers` (`op`, `example`, `schemaRefs`) |
| Tool | `openapi_diff` | Read-only semantic breaking vs non-breaking diff between `base_spec_path` and `target_spec_path` |
| Prompts | `sync-frontend-api`, `audit-error-contracts`, `review-breaking-changes`, `generate-test-fixtures` | Guided agent workflows verified by anti-prompt-drift tests |

---

## Verification Scope

- Unit tests in [tests/engine.test.ts](../../tests/engine.test.ts) cover circular & multi-file `$ref` resolution, path traversal and symlink rejection, warm-cache invalidation (including deleted `$ref` files), `EACCES`-safe catalog scanning, YAML `sourceLocation` tracking, schema index reverse references, deterministic example generation, multi-issue diagnostics, semantic diffing, QuickJS sandbox isolation, and byte-budget enforcement.
- Protocol & CLI contract tests in [tests/mcp-contract.test.ts](../../tests/mcp-contract.test.ts) cover monorepo selection, search pagination, `initialize`, `tools/list` annotations, `resources/list` + `resources/templates/list` + `resources/read`, `prompts/list` + `prompts/get` anti-prompt-drift checks, `openapi_query` + `openapi_diff` over `InMemoryTransport`, and CLI (`serve`, `check`, `diff`, `--help`, `--version`, `stdio` lifecycle).
