---
name: use-openapi-mcp
description: >-
  Inspect, validate, diff, and generate sample payloads from OpenAPI 3.0/3.1 and Swagger 2.0 specifications via openapi-mcp without loading raw YAML/JSON files into context. Use when listing endpoints or schemas, finding endpoints affected by a schema change, auditing 4xx/5xx error responses, syncing frontend/backend API contracts, comparing spec revisions for breaking changes, or working with multi-file $ref specs.
---

# use-openapi-mcp

Prefer `openapi-mcp` over reading raw `openapi.yml`/`openapi.json` files directly. Reading raw spec files into context wastes tokens and commonly causes three issues:
1. **Missed `$ref` targets and inherited rules:** Searching raw files often misses cross-file `$ref` targets, path-level `parameters` inherited from `paths[p].parameters`, and global `security` vs operation-level `security: []` overrides.
2. **Missing error contracts:** Inspecting only `2xx` responses overlooks `4xx`/`5xx` error schemas, undocumented status codes, and `readOnly`/`writeOnly` field differences.
3. **Lost component references after `$ref` expansion:** Expanding `$ref` inline removes component schema names, making it harder to see which endpoints depend on a shared schema.

## Core Practices

- **Read indexes before querying details:** Start with compact indexes (`endpoints/index`, `schemas/index`) before querying individual operations. Narrow `openapi_query` expressions to the specific operation or status code rather than increasing `max_bytes`.
- **Validate the spec before relying on it:** Existing specs can contain broken `$ref`s, undeclared `{path}` parameters, unknown `security` schemes, or missing error schemas. Run diagnostics before treating a spec as accurate.
- **Check schema consumers before editing:** Use pre-expansion usage tracking (`schemas/index` or `helpers.schemaRefs`) to identify all affected endpoints before modifying a shared schema.
- **Fallback when MCP is unavailable:** Prefer `openapi-mcp` MCP resources/tools when connected. If no MCP server is attached, use the `openapi-mcp check` / `openapi-mcp diff` CLI commands if installed, or fall back to targeted `rg` and file reads while manually checking path-level parameters, `$ref` targets, and `4xx`/`5xx` responses.

## Intent-to-Primitive Routing

| Intent | MCP Resource / Tool | Purpose |
| --- | --- | --- |
| **Discover specs in a monorepo** | `read_resource("openapi://specs/catalog")` | Finds entry specs while skipping unreadable (`EACCES`) and build/vendor directories; pass the chosen `spec_path` consistently thereafter. |
| **List endpoints & error coverage** | `read_resource("openapi://endpoints/index")` | Lists methods, paths, `2xx`/`4xx`/`5xx` codes, `errorBodies`, `security`, `deprecated`, `tags`, and `sourceLocation` (`{ file, line }`). Soft-capped at `64 KB`. |
| **Filter & paginate large indexes** | `read_resource("openapi://endpoints/search?q=orders&method=POST&pathPrefix=/api&tag=Checkout&missingErrorContracts=false&limit=20&offset=0&spec_path=...")` | Avoids oversized responses; follow `nextUri` for subsequent pages. |
| **List schemas & their consumers** | `read_resource("openapi://schemas/index")` or `openapi://schemas/search?q=Order&unusedOnly=false&usedByPath=/orders` | Exposes `required`, `properties`, `sourceLocation`, and pre-expansion `usedBy` references. |
| **Validate contract health** | `read_resource("openapi://spec/diagnostics")` (`?spec_path=...`) | Reports all broken `$ref`s, duplicate `operationId`, undeclared `{path}` params, unknown `security` schemes, and missing error contracts in one pass. |
| **Inspect one merged operation** | `openapi_query({ code: "helpers.op('POST', '/orders')", spec_path? })` | Merges path + operation `parameters`, resolves effective `security` (respecting `[]`), and attaches `sourceLocation` for direct YAML/JSON navigation. |
| **Generate deterministic sample payloads** | `openapi_query({ code: "helpers.example('POST', '/orders', '201')", spec_path? })` | Generates format-aware, circular-safe JSON samples respecting `readOnly`/`writeOnly` fields (also accepts `helpers.example(schema)`). |
| **Find endpoints using a schema** | `openapi_query({ code: "helpers.schemaRefs('Order')", spec_path? })` | Returns `[{ method, path, section }]` captured prior to `$ref` expansion. |
| **Detect breaking changes** | `openapi_diff({ base_spec_path, target_spec_path })` | Classifies `breaking` vs `non_breaking` changes across endpoints, parameters, request bodies, and responses. |

## Client Compatibility

MCP clients that only expose `resources/list` (and not `resources/templates/list`) can still pass query parameters directly to `read_resource`:
- `openapi://endpoints/index?spec_path=<path>`
- `openapi://endpoints/search?q=<term>&limit=20&spec_path=<path>`
- `openapi://schemas/index?spec_path=<path>`
- `openapi://schemas/search?q=<term>&limit=20&spec_path=<path>`
- `openapi://spec/diagnostics?spec_path=<path>`
