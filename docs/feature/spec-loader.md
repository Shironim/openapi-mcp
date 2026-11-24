# Specification Loader

The engine, indexes, search templates, and query sandbox use `loadOpenApiSpec` to select, parse, and resolve an immutable OpenAPI snapshot.

Discovery checks `openapi.yml`, `openapi.yaml`, and `openapi.json` in the workspace root, followed by `api/` and `docs/`. An explicit `spec_path` or `--spec` option takes precedence over convention-based discovery.

For monorepos or nested services, read `openapi://specs/catalog` and pass the desired path as `spec_path`.

## Local `$ref` Resolution

Relative `$ref` paths are resolved from the referring file. The loader accepts local regular files inside the workspace and resolves JSON Pointer fragments, including percent-encoding, escaped keys (`~0`, `~1`), and empty keys. Remote references and paths whose canonical `realpath` escapes the workspace boundary are rejected.

- Missing referenced files raise `REF_FILE_NOT_FOUND`, identifying both the referring file and missing target.
- Missing entry specifications cause index and search resources to return `status: "spec_not_found"` with the candidate paths checked.

Cyclic references are tracked by object identity and replaced with a `[Circular: <ref>]` marker so recursive schemas remain inspectable without infinite expansion.

For OpenAPI 3.1 Schema Objects with sibling keywords alongside `$ref`, the target schema is preserved via `allOf` alongside the local keywords. Schema-resource identifiers (`$id`), named anchors (`$anchor`), and dynamic references (`$dynamicRef`) are outside the supported resolver subset and raise an error if encountered.

## Source Mapping & Reverse Schema Usage

`loadOpenApiSpec` parses each YAML/JSON file once using `yaml` v2 `parseDocument` and `LineCounter` ([source-map.ts](../../src/engine/source-map.ts)), producing 1-based `{ file, line, col }` `sourceLocations` for paths, operations, and component schemas without a second parse pass.

During `$ref` expansion, before inlining removes reference boundaries, the loader builds a reverse usage map (`schemaUsages`) linking each local `components.schemas` / `definitions` entry to the operations and sections (`requestBody`, `parameters`, `response:<status>`) that reference it. Both `sourceLocations` and `schemaUsages` are frozen and exposed to indexes and sandbox `helpers`.

## Caching & Resource Limits

The loader caches up to eight entry specifications keyed by workspace root and canonical entry path (`${root}\0${entry}`). On a cache hit, an `O(F)` `statSync` check compares `mtimeMs`, `ctimeMs`, and `size` across all dependencies before falling back to a full read and SHA-256 verification. Deleted `$ref` files and retargeted symlinks invalidate stale cache entries automatically.

Safety limits enforced during loading:
- **Source files:** max 128 files, max 8 MiB cumulative input
- **Expansion:** max 250,000 node visits, max depth 128, max 8 MiB serialized snapshot
- **Error codes:** `SPEC_NOT_FOUND`, `REF_FILE_NOT_FOUND`, `INVALID_REF`, `PATH_TRAVERSAL_DENIED`, `SPEC_LIMIT`
