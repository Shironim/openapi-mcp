# Endpoint Index & Workflow Prompts

Implemented in [src/engine/index-builder.ts](../../src/engine/index-builder.ts) and [src/mcp/server.ts](../../src/mcp/server.ts).

---

## Choose a spec

Read `openapi://specs/catalog` to get sorted workspace-relative paths, for example `{"specPaths":["apps/billing/openapi.yaml","apps/sales/openapi.yaml"]}`. The catalog matches filenames. The server parses a file when you request its index, search results, or a query. If the list is empty, check the workspace root or pass a known custom filename as `spec_path`.

## Read the endpoint index

Use `openapi://endpoints/index` for the default spec or `openapi://endpoints/index?spec_path=apps/billing/openapi.yaml` for Billing.

- **MIME Type:** `application/json`
- **Behavior:** Indexes the default specification or a request-local `spec_path` selection. Query overrides are request-local. The resource refreshes the shared spec cache when source files change.
- **Line Format:**
  ```text
  METHOD /path — summary — [200, 400, 404, 422, 500]
  ```
- **Fields Returned:**
  - `title`, `version`, `openapiVersion`, `specPath`
  - `totalEndpoints`, `endpointsWithErrorContracts`
  - `endpointsMissingErrorContracts`: list of `"METHOD /path"` entries that declare no explicit `4xx` or `5xx` response. A `default` response remains visible in `statusCodes`.
  - `lines`: compact string array for quick scanning
  - `endpoints`: structured array with `method`, `path`, `operationId`, `summary`, `tags`, `statusCodes`, `errorStatusCodes`, `errorBodies`, and `line`
- **Missing Spec Handling:** If no OpenAPI spec exists in the active workspace root, returns a valid JSON diagnostic object with `status: "spec_not_found"`, `checkedCandidates`, and a hint to configure server defaults or use a request-local query. Index output is limited to 1 MiB.

---

## Search endpoints

The search resource template `openapi://endpoints/search{?q,tag,operationId,offset,limit,spec_path}` accepts the same spec selection as the index. The optional substring filter `q` matches method, path, summary, tag, or operation ID. Tag and operation ID filters match exact values. Filters combine and ignore case. Offset starts at zero. The page size defaults to 20 and accepts 1–100. Results contain `totalMatches`, `endpoints`, and a `nextUri` that is null on the final page. Each request reads the current specification, so edits between pages can change their contents.

The full index counts operations with explicit error statuses. Its endpoint entries and the search results use the same response summary. For each such status, `errorBodies[status].schemaMediaTypes` lists content entries declaring a schema. Swagger 2 responses with a response-level schema carry `hasSwaggerSchema: true`. Inspect the response with `openapi_query` to determine its fields and constraints.

If the full index exceeds 1 MiB, follow the search URI in the `INDEX_LIMIT` error. For an oversized page, reduce `limit` or narrow the filters. For a single oversized operation, query the relevant field with `openapi_query`. If `totalMatches` is zero, broaden your filters or check `spec_path`.

## Use workflow prompts

Each prompt returns instructions for the agent. In a monorepo, carry the selected `spec_path` into resource reads and tool calls. The prompts themselves accept only the optional `endpoint` argument.

### `sync-frontend-api`

- **Arguments:** `endpoint` (optional, e.g. `"POST /orders"` or `"/users"`)
- **Workflow:** Guides the agent to:
  1. Read `openapi://endpoints/index` to verify exact path, method, and all declared `2xx` + `4xx`/`5xx` status codes.
  2. Call `openapi_query` to inspect path-level and operation-level `parameters`, `requestBody`, `2xx` responses, and every `4xx`/`5xx` error schema.
  3. Align frontend API client types, request payloads, and error handling branches with the OpenAPI contract.

### `audit-error-contracts`

- **Arguments:** `endpoint` (optional)
- **Workflow:** Guides the agent to:
  1. Read `openapi://endpoints/index` and inspect `endpointsMissingErrorContracts` and `errorStatusCodes`.
  2. Call `openapi_query` to inspect `4xx`/`5xx` response schemas (e.g. `ProblemDetails`, validation error payloads) for completeness and consistency.
  3. Report missing error contracts and schema inconsistencies.

---

## Anti-Prompt-Drift Contract

`tests/mcp-contract.test.ts` verifies against live `tools/list` and `resources/list` responses that every tool name (`openapi_query`), parameter (`code`, `spec_path`, `root`, `max_bytes`), and resource URI (`openapi://endpoints/index`) referenced in rendered prompt messages exists in the active server schemas.
