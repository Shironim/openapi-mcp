# Specification loader

The library, endpoint index, endpoint search, and query use `loadOpenApiSpec` to select, parse, and expand one immutable snapshot. Discovery checks `openapi.yml`, `openapi.yaml`, and `openapi.json` in the workspace root, then in `api/` and `docs/`. An explicit path takes precedence.

Default selection uses the first matching candidate. To find specs in nested projects, read `openapi://specs/catalog` and pass one returned path as `spec_path`. Each service keeps its own paths and components.

## Local references

Relative `$ref` paths are resolved from the referring file. The loader accepts local files inside the workspace and resolves JSON Pointer fragments, including percent encoding, escaped keys, and empty keys. It rejects remote references and paths whose canonical targets are outside the workspace. Source reads require regular files.

If a referenced file is missing, `REF_FILE_NOT_FOUND` identifies the referring file and the target. Restore the file or correct the reference, then retry. A missing entry spec produces a different result: index and search return `status: "spec_not_found"` with the paths checked. Select a path from the catalog or correct the configured default.

Current paths in the expansion are tracked by object identity. A cyclic reference produces a `[Circular: <ref>]` inspection marker. An acyclic target can appear at multiple locations. Markers let readers inspect recursive shapes without expanding them indefinitely.

For an OpenAPI 3.1 Schema Object with sibling assertions, the target is retained in `allOf` alongside the local keywords. For example, a target with `minLength: 5` and a local `minLength: 1` retain both constraints. Schema and response descriptions remain available for inspection. Examples and extension data stay as data. Schema-resource identifiers, named anchor references, and dynamic references are outside the supported resolver subset and raise an error where encountered.

## Cache and limits

The cache holds eight entry specifications. A hit revalidates reference aliases and file fingerprints (mtime and SHA-256), including external files. When a dependency changes, its current read is reused during the rebuild. A retargeted symlink changes the resolved snapshot even when the previous target is still present. The cache key covers the whole dependency set.

The source file count is limited to 128 and cumulative input to 8 MiB. Expansion allows up to 250,000 node visits and 128 levels. Serialized snapshots have an 8 MiB limit. Cache validation uses synchronous local I/O. Load and query errors include codes such as `SPEC_NOT_FOUND`, `INVALID_REF`, `PATH_TRAVERSAL_DENIED`, and `SPEC_LIMIT`.
