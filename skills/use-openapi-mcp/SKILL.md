---
name: use-openapi-mcp
description: >-
  Inspect, validate, diff, and synthesize fixtures from local OpenAPI 3.0/3.1 and Swagger 2.0 specifications using openapi-mcp (catalog, endpoint/schema indexes, multi-issue diagnostics, sandboxed openapi_query + helpers, and openapi_diff) without dumping raw YAML/JSON files into context.
---

# use-openapi-mcp — Local Code Mode OpenAPI Inspection

Prefer `openapi-mcp` over reading raw `openapi.yml`/`openapi.json` files whenever a repository has OpenAPI specs (especially large or multi-file `$ref` specs).

## Intent-to-Primitive Routing Table

| Intent | MCP Resource / Tool | Notes |
| --- | --- | --- |
| **Discover specs in a monorepo** | `read_resource("openapi://specs/catalog")` | Skips unreadable (`EACCES`) & build/vendor dirs; returns `specPaths` (+ `skippedDirs` if any). |
| **Survey all endpoints** | `read_resource("openapi://endpoints/index")` | Returns status codes (`2xx`/`4xx`/`5xx`), `errorBodies`, `security`, `deprecated`, `tags`, and `sourceLocation` (`{ file, line }`). Soft-capped at `64 KB`. |
| **Search & paginate endpoints** | `read_resource("openapi://endpoints/search?q=orders&method=POST&pathPrefix=/api&tag=Checkout&missingErrorContracts=false&limit=20&offset=0&spec_path=...")` | Works even in MCP clients that do not expose `resources/templates/list`. Follow `nextUri` for next page. |
| **Survey reusable schemas & blast radius** | `read_resource("openapi://schemas/index")` or `openapi://schemas/search?q=Order&unusedOnly=false&usedByPath=/orders` | Lists `components.schemas` / `definitions` with `required`, `properties`, `sourceLocation`, and reverse references (`usedBy`). |
| **Validate contract health** | `read_resource("openapi://spec/diagnostics")` (append `?spec_path=...` for non-default spec) | Multi-issue single-pass report: all broken `$ref`s, duplicate `operationId`, undeclared `{path}` params, unknown `security` schemes, missing error contracts/schemas. |
| **Inspect one operation completely** | `openapi_query({ code: "helpers.op('POST', '/orders')", spec_path? })` | Merges path-level + operation-level `parameters`, resolves effective `security`, and attaches `sourceLocation`. |
| **Generate deterministic JSON fixtures** | `openapi_query({ code: "helpers.example('POST', '/orders', '201')", spec_path? })` | Deterministic sample synthesis (format-aware, circular-safe). Also accepts `helpers.example(schema)`. |
| **Find endpoints using a schema** | `openapi_query({ code: "helpers.schemaRefs('Order')", spec_path? })` | Returns `[{ method, path, section }]` recorded before `$ref` expansion. |
| **Compare two specs for breaking changes** | `openapi_diff({ base_spec_path: "openapi.yml", target_spec_path: "docs/openapi.yml" })` | Classifies `breaking` vs `nonBreaking` across endpoints, parameters, request bodies, and responses. |

## Recommended Workflow

1. **Multi-spec / Monorepo:** Read `openapi://specs/catalog` first, then pass the chosen `spec_path` consistently to resources and tools.
2. **Index-First, Query-On-Demand:** Read `openapi://endpoints/index` (or `openapi://endpoints/search?...` when large) before calling `openapi_query`.
3. **Never Miss Error Contracts or Auth:** Always check both `2xx` and `4xx`/`5xx` responses plus `security` via `helpers.op(method, path)`.
4. **Jump Directly to YAML Lines:** Use `sourceLocation` (`{ file, line }`) from the index or `helpers.op` when editing OpenAPI files.
5. **Respect Byte Budgets:** If `openapi_query` returns `RESPONSE_BUDGET_EXCEEDED`, narrow the JS expression to a single operation, status code, or schema property rather than raising `max_bytes` blindly.

## Client Compatibility Note

Some MCP clients only list static resources (`resources/list`) and do not surface `resources/templates/list`. You can still call `read_resource` directly with query parameters on:
- `openapi://endpoints/index?spec_path=<path>`
- `openapi://endpoints/search?q=<term>&limit=20&spec_path=<path>`
- `openapi://schemas/index?spec_path=<path>`
- `openapi://schemas/search?q=<term>&limit=20&spec_path=<path>`
- `openapi://spec/diagnostics?spec_path=<path>`
