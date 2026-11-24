# Indexes, Diagnostics & Workflow Prompts

Implemented in [src/engine/spec-catalog.ts](../../src/engine/spec-catalog.ts), [src/engine/index-builder.ts](../../src/engine/index-builder.ts), [src/engine/schema-index.ts](../../src/engine/schema-index.ts), [src/engine/spec-diagnostics.ts](../../src/engine/spec-diagnostics.ts), and [src/mcp/server.ts](../../src/mcp/server.ts).

---

## Workspace Catalog (`openapi://specs/catalog`)

Reads workspace-relative OpenAPI entry filenames (`openapi.yml`, `openapi.yaml`, `openapi.json`) without parsing file contents.
- Skips symlinks and common build/vendor/cache directories (`node_modules`, `vendor`, `.git`, `dist`, `build`, `storage`, `.next`, `.nuxt`, `.venv`, `target`, `coverage`, etc.).
- Gracefully skips unreadable or transient directories (`EACCES`, `EPERM`, `ENOENT`, `ENOTDIR`, `ELOOP`) and reports `skippedDirCount` + up to 25 sample `skippedDirs` instead of failing the whole scan.

---

## Endpoint Index & Search (`openapi://endpoints/index`, `openapi://endpoints/search`)

- **Fields returned:** `title`, `version`, `openapiVersion`, `specPath`, `totalEndpoints`, `tags`, `endpointsWithErrorContracts`, `endpointsMissingErrorContracts`, `lines`, and `endpoints[]` (each with `method`, `path`, `operationId`, `summary`, `tags`, `deprecated`, effective `security`, `statusCodes`, `errorStatusCodes`, `errorBodies`, `sourceLocation`, and `line`).
- **Context-safe soft cap:** Full `openapi://endpoints/index` enforces a **64 KB** soft limit and directs agents to `openapi://endpoints/search?limit=20` when exceeded.
- **Search template:** `openapi://endpoints/search{?q,tag,method,pathPrefix,operationId,missingErrorContracts,offset,limit,spec_path}` supports case-insensitive substring matching (`q`), exact `tag`/`method`/`operationId`, `pathPrefix`, boolean `missingErrorContracts`, and `nextUri` pagination (`limit` 1–100, default 20).

---

## Component Schema Index & Search (`openapi://schemas/index`, `openapi://schemas/search`)

- Indexes `components.schemas` (OpenAPI 3.x) or `definitions` (Swagger 2.0) with `name`, `type`, `description`, `required`, `properties`, `enumValues`, `sourceLocation`, and reverse references (`usedBy`: e.g. `"POST /orders (requestBody)"`).
- Also lists `unusedSchemas` and enforces the same **64 KB** soft cap with redirect to `openapi://schemas/search?limit=20`.
- **Search template:** `openapi://schemas/search{?q,usedByPath,unusedOnly,offset,limit,spec_path}`.

---

## Multi-Issue Diagnostics (`openapi://spec/diagnostics{?spec_path}`)

Runs a non-throwing single-pass check collecting up to 200 issues:
- Broken/remote/escaping `$ref`s (`BROKEN_REF`, `REMOTE_REF_DENIED`, `PATH_TRAVERSAL_DENIED`, `REF_PARSE_ERROR`)
- Missing `openapi`/`swagger` version or `info.title`
- Duplicate `operationId` (`DUPLICATE_OPERATION_ID`)
- Path template `{param}` not declared in `in: "path"` parameters (`UNDECLARED_PATH_PARAMETER`)
- Referenced `security` scheme missing from `components.securitySchemes` (`UNKNOWN_SECURITY_SCHEME`)
- Operations missing `4xx`/`5xx` contracts (`MISSING_ERROR_CONTRACT`) or error responses without schemas (`ERROR_RESPONSE_MISSING_SCHEMA`)

---

## Workflow Prompts

1. **`sync-frontend-api`** (`endpoint?`): Read endpoint/schema indexes → inspect merged contract via `helpers.op` → align frontend types, auth, and `4xx`/`5xx` branches.
2. **`audit-error-contracts`** (`endpoint?`): Read `openapi://spec/diagnostics` + `openapi://endpoints/index` → inspect `4xx`/`5xx` schemas → report gaps with `sourceLocation`.
3. **`review-breaking-changes`** (`base_spec_path?`, `target_spec_path?`): Call `openapi_diff` → inspect impacted endpoints/schemas with `helpers.op` / `helpers.schemaRefs` → summarize migration impact.
4. **`generate-test-fixtures`** (`endpoint?`): Read endpoint index → synthesize deterministic `2xx` and `4xx`/`5xx` JSON fixtures via `helpers.example`.

All prompt references to tools, parameters, and resource URIs are verified against live server schemas in [tests/mcp-contract.test.ts](../../tests/mcp-contract.test.ts).
