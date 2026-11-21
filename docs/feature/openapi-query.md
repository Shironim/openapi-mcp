# Code Mode Query

`openapi_query` evaluates synchronous JavaScript expressions, arrow functions, or statement bodies with `return`. The tool accepts `code` (required, up to 16,384 characters), optional `root` and `spec_path`, and optional integer `max_bytes`. The same Zod definition validates arguments and generates the MCP tool schema.

```js
Object.keys(spec.paths ?? {})
```

```js
spec.paths['/users']?.get?.responses
```

## Workspace and data

Use the same `spec_path` for search, index, and query to inspect one service throughout a session. Each selection applies to one request. A query with an explicit `root` and no `spec_path` checks the default filename candidates under that root, even if the server was started with `--spec`. If the server has a configured root, the query root and all referenced files must stay within that workspace. With no configured root, the server defaults to its working directory and the client can select a local root per request.

The loader freezes its snapshot and creates one JSON representation for query execution. Queries receive that data in a fresh QuickJS runtime compiled to WebAssembly. The runtime receives no host handles, callbacks, module loader, filesystem APIs, or networking APIs. Static syntax and API checks provide early feedback.

For example, after finding Billing in the catalog, call `openapi_query` with these arguments.

```json
{"spec_path":"apps/billing/openapi.yaml","code":"spec.info.title"}
```

## Execution and output

- The default guest deadline is 150 ms. QuickJS checks the deadline through its interrupt handler. Guest memory is limited to 64 MiB and the guest stack to 512 KiB.
- The guest freezes `spec`, evaluates the query, and serializes the result to JSON. The host receives JSON text. Promise and thenable results are rejected. The server does not drain guest async jobs.
- Successful result text defaults to a 16 KiB UTF-8 budget, with an override between 1 byte and 1 MiB. The hard limit for serialized query results is 1 MiB. Structured content mirrors object results, so total JSON-RPC bytes can exceed the result-text budget.
- Within the hard limit, an oversized success result becomes a separate `RESPONSE_BUDGET_EXCEEDED` diagnostic with bounded keys and preview. Diagnostic size is independent of the requested success budget. An undefined result becomes a JSON note and goes through the same success budget.
- Use the deepest relevant path, method, status, or schema key when a query exceeds a limit. A guest deadline covers guest setup, evaluation, and serialization. Local file loading and MCP transport are separate stages.

The reusable `runSandboxQuery` function and the MCP handler use the same evaluator. The package keeps the library function synchronous after module initialization.
