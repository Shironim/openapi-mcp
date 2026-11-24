# Code Mode Query (`openapi_query`) & Semantic Diff (`openapi_diff`)

## `openapi_query`

`openapi_query` evaluates synchronous JavaScript expressions, arrow functions, or statement bodies with `return`. The tool accepts `code` (required, up to 16,384 characters), optional `root` and `spec_path`, and optional integer `max_bytes`.

```js
helpers.op('POST', '/orders')
```

```js
helpers.example('POST', '/orders', '422')
```

```js
helpers.schemaRefs('ProblemDetails')
```

### Built-in Read-Only `helpers`

Inside the QuickJS guest runtime, a frozen `helpers` global is exposed alongside `spec` (pure guest JS, zero host callbacks):

- `helpers.op(method, path)`: Returns the merged operation contract with path-level + operation-level `parameters` combined (operation overrides path on matching `in` + `name`), effective `security` (inheriting top-level `spec.security` unless overridden), and `sourceLocation`.
- `helpers.example(method, path, statusCode?)` or `helpers.example(schema)`: Deterministically synthesizes JSON sample payloads (honoring `example`/`examples` → `const` → `default` → `enum` → `format` → `type`, merging `allOf`, respecting `readOnly`/`writeOnly`, and safely terminating `[Circular: ...]` markers).
- `helpers.schemaRefs(schemaName?)`: Returns reverse references (`[{ method, path, section }]`) recorded during `$ref` resolution before inlining.

### Execution & Resource Bounds

- **Isolated timeouts:** Guest spec bootstrap (`JSON.parse` + recursive `Object.freeze`) has a bounded 2,000 ms setup cap, separate from the query execution deadline (default **150 ms**). Large specs do not cause false `SANDBOX_TIMEOUT` failures before the query runs.
- **Memory & stack:** Guest memory is limited to 64 MiB and stack to 512 KiB. Promise/thenable return values are rejected.
- **Byte budget:** Successful result text defaults to 16 KiB UTF-8 (configurable up to 1 MiB). Oversized results return `RESPONSE_BUDGET_EXCEEDED` with available keys and narrowing hints.

---

## `openapi_diff`

`openapi_diff` compares two local OpenAPI specifications inside the configured workspace (`base_spec_path` vs `target_spec_path`, plus optional `root` and `max_bytes`).

```json
{
  "base_spec_path": "openapi.yml",
  "target_spec_path": "docs/openapi.yml"
}
```

It returns `hasBreakingChanges`, `summary` (`breakingCount`, `nonBreakingCount`, `addedEndpoints`, `removedEndpoints`, `truncated`), `breaking[]`, and `nonBreaking[]`, classifying:
- **Breaking:** removed endpoints, removed response status codes or media types, new required parameters or request properties, optional-to-required request changes, required-to-optional response changes, schema type changes, removed request enum values, added response enum values.
- **Non-breaking:** added endpoints, newly deprecated endpoints, new optional request parameters/properties, added response statuses or properties, new request media types.
