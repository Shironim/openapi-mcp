import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isRecord } from './json.js';
import { parseDocumentWithLocations, type SourceLocation } from './source-map.js';
import type { SchemaUsageRef } from './schema-index.js';

export const DEFAULT_SPEC_CANDIDATES = [
  'openapi.yml', 'openapi.yaml', 'openapi.json',
  'api/openapi.yml', 'api/openapi.yaml', 'api/openapi.json',
  'docs/openapi.yml', 'docs/openapi.yaml', 'docs/openapi.json',
] as const;

export const MAX_SPEC_BYTES = 8 * 1024 * 1024;
export const MAX_SPEC_FILES = 128;
const MAX_NODE_VISITS = 250_000;
const MAX_DEPTH = 128;
const MAX_CACHED_SPECS = 8;

export class MissingReferenceError extends Error {
  readonly code = 'REF_FILE_NOT_FOUND';
  constructor(target: string, source: string) {
    super(`REF_FILE_NOT_FOUND: Reference '${target}' from '${source}' does not exist. Restore the file or correct the reference.`);
  }
}

export interface FileFingerprint {
  filePath: string;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  sha256: string;
}

export interface LoadedOpenApiSpec {
  spec: Record<string, unknown>;
  specPath: string;
  rootDir: string;
  cacheKey: string;
  fromCache: boolean;
  dependencies: FileFingerprint[];
  sourceLocations: Readonly<Record<string, SourceLocation>>;
  schemaUsages: Readonly<Record<string, readonly SchemaUsageRef[]>>;
}

export interface LoadOpenApiSpecOptions {
  specPath?: string;
  rootDir?: string;
  allowedRootDir?: string;
}

interface CachedSpec {
  loaded: Omit<LoadedOpenApiSpec, 'fromCache'>;
  locations: Map<string, string>;
}

export interface FileSnapshot {
  fingerprint: FileFingerprint;
  content: string;
  size: number;
}

const specCache = new Map<string, CachedSpec>();
const snapshotJson = new WeakMap<object, string>();

/** Serialize loader-owned snapshots once. Library callers can also supply their own data. */
export function serializeSpec(spec: unknown): string {
  const cached = spec !== null && typeof spec === 'object' ? snapshotJson.get(spec) : undefined;
  if (cached !== undefined) return cached;
  const text = JSON.stringify(spec) ?? 'null';
  if (Buffer.byteLength(text) > MAX_SPEC_BYTES) {
    throw new Error(`SPEC_LIMIT: Serialized spec exceeds ${MAX_SPEC_BYTES} bytes.`);
  }
  return text;
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function resolveRoot(path: string): string {
  try {
    const canonicalPath = realpathSync(path);
    if (statSync(canonicalPath).isDirectory()) return canonicalPath;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  throw new Error(`WORKSPACE_NOT_FOUND: Workspace directory '${path}' does not exist.`);
}

function resolveFile(
  target: string,
  root: string,
  base: string,
  rawRoot?: string
): { candidate: string; canonical: string } | undefined {
  const path = target.trim();
  if (!path) throw new Error('INVALID_SPEC_PATH: File path cannot be empty.');
  const windowsDrivePath = process.platform === 'win32' && /^[a-z]:[\\/]/i.test(path);
  if (!windowsDrivePath && /^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw new Error(`REMOTE_REF_DENIED: Only local workspace paths are permitted ('${target}').`);
  }

  const candidate = resolve(base, path);
  if (!isPathInside(root, candidate) && !(rawRoot && isPathInside(resolve(rawRoot), candidate))) {
    throw new Error(`PATH_TRAVERSAL_DENIED: Path '${target}' escapes workspace root '${root}'.`);
  }
  try {
    const canonical = realpathSync(candidate);
    if (!isPathInside(root, canonical)) {
      throw new Error(`PATH_TRAVERSAL_DENIED: Resolved path '${target}' escapes workspace root '${root}'.`);
    }
    return { candidate, canonical };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function requireFile(target: string, root: string, base: string, rawRoot?: string) {
  const location = resolveFile(target, root, base, rawRoot);
  if (location) return location;
  throw new Error(`SPEC_FILE_NOT_FOUND: File '${target}' does not exist inside workspace '${root}'.`);
}

export function resolveSafeSpecPath(
  targetPath: string,
  rootRealPath: string,
  baseDir = rootRealPath,
  rawRootDir?: string
): string {
  return requireFile(targetPath, rootRealPath, baseDir, rawRootDir).canonical;
}

function discoverSpec(root: string, rawRoot: string, explicitPath?: string): string {
  if (explicitPath?.trim()) return requireFile(explicitPath, root, root, rawRoot).canonical;
  for (const candidate of DEFAULT_SPEC_CANDIDATES) {
    const location = resolveFile(candidate, root, root);
    if (location) return location.canonical;
  }
  throw new Error(
    `SPEC_NOT_FOUND: No OpenAPI spec in '${root}'. Checked: ${DEFAULT_SPEC_CANDIDATES.join(', ')}.`
  );
}

export function assertWorkspaceRoot(rootInput: string, allowedRootDir?: string): string {
  const root = resolveRoot(rootInput);
  if (allowedRootDir && allowedRootDir !== rootInput &&
      !isPathInside(resolveRoot(allowedRootDir), root)) {
    throw new Error('PATH_TRAVERSAL_DENIED: Requested root is outside the configured workspace.');
  }
  return root;
}

export function findOpenApiSpecFile(rootDir: string, explicitPath?: string): string {
  return discoverSpec(resolveRoot(rootDir), rootDir, explicitPath);
}

export function readBoundedFileSnapshot(path: string, availableBytes: number): FileSnapshot {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error(`INVALID_SPEC_PATH: '${path}' must be a regular file.`);
    if (before.size > availableBytes) throw new Error(`SPEC_LIMIT: Source files exceed ${MAX_SPEC_BYTES} bytes.`);
    const bytes = Buffer.allocUnsafe(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const moved = readSync(fd, bytes, count, bytes.length - count, null);
      if (moved === 0) break;
      count += moved;
    }
    const after = fstatSync(fd);
    if (count !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`SPEC_CHANGED: '${path}' changed during read. Retry the query.`);
    }
    const content = bytes.subarray(0, count);
    return {
      fingerprint: {
        filePath: path,
        mtimeMs: after.mtimeMs,
        ctimeMs: after.ctimeMs,
        size: count,
        sha256: createHash('sha256').update(content).digest('hex'),
      },
      content: content.toString('utf8'),
      size: count,
    };
  } finally {
    closeSync(fd);
  }
}

export function resolveJsonPointerSafe(
  document: unknown,
  fragment: string
): { ok: true; value: unknown } | { ok: false; reason: string } {
  let pointer: string;
  try {
    pointer = decodeURIComponent(fragment);
  } catch {
    return { ok: false, reason: 'Invalid URI encoding in JSON Pointer.' };
  }
  if (pointer === '') return { ok: true, value: document };
  if (!pointer.startsWith('/')) return { ok: false, reason: 'Fragment must use a JSON Pointer starting with "/".' };

  let value = document;
  for (const segment of pointer.slice(1).split('/')) {
    if (/~(?![01])/.test(segment)) return { ok: false, reason: `Invalid pointer escape in '${segment}'.` };
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(value) && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length) {
      value = value[Number(key)];
    } else if (isRecord(value) && Object.hasOwn(value, key)) {
      value = value[key];
    } else {
      return { ok: false, reason: `Unresolved JSON Pointer segment '${key}'.` };
    }
  }
  return { ok: true, value };
}

function resolvePointer(document: unknown, fragment: string, ref: string): unknown {
  const result = resolveJsonPointerSafe(document, fragment);
  if (!result.ok) {
    throw new Error(`INVALID_REF: '${ref}': ${result.reason}`);
  }
  return result.value;
}

export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

type Position = 'document' | 'named-map' | 'example-map' | 'example-object' | 'schema' | 'schema-map' | 'schema-list' | 'literal';

const schemaMaps = new Set(['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions']);
const schemaLists = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const schemaChildren = new Set([
  'items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties',
  'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema',
]);
const annotations = new Set([
  'title', 'description', '$comment', 'examples', 'example', 'default', 'deprecated',
  'readOnly', 'writeOnly', 'externalDocs', 'xml',
]);

const OPERATION_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);

interface OperationContext {
  method: string;
  path: string;
  section?: string;
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function extractLocalSchemaName(fragment: string): string | undefined {
  for (const prefix of ['/components/schemas/', '/definitions/']) {
    if (fragment.startsWith(prefix)) {
      const rest = fragment.slice(prefix.length);
      const firstSegment = rest.split('/')[0];
      if (!firstSegment) return undefined;
      try {
        return decodePointerSegment(decodeURIComponent(firstSegment));
      } catch {
        return decodePointerSegment(firstSegment);
      }
    }
  }
  return undefined;
}

function nextOperationContext(
  current: OperationContext | undefined,
  inEntryFile: boolean,
  pointer: string,
  key: string
): OperationContext | undefined {
  if (!inEntryFile) return current;
  if (!current) {
    if (pointer.startsWith('/paths/')) {
      const segments = pointer.slice('/paths/'.length).split('/');
      if (segments.length === 1 && OPERATION_METHODS.has(key.toLowerCase())) {
        return { method: key.toUpperCase(), path: decodePointerSegment(segments[0]!) };
      }
    }
    return undefined;
  }
  if (current.section) return current;
  if (key === 'requestBody' || key === 'parameters') {
    return { ...current, section: key };
  }
  if (pointer.endsWith('/responses')) {
    return { ...current, section: `response:${key}` };
  }
  return current;
}

function childPosition(parent: Position, key: string, pointer: string): Position {
  if (parent === 'named-map') return 'document';
  if (parent === 'example-map') return 'example-object';
  if (parent === 'example-object' && key === 'value') return 'literal';
  if (parent === 'schema-map' || parent === 'schema-list') return 'schema';
  if (parent === 'schema') {
    if (schemaMaps.has(key)) return 'schema-map';
    if (schemaLists.has(key)) return 'schema-list';
    if (schemaChildren.has(key)) return 'schema';
    return 'literal';
  }
  if (key === 'example' || key.startsWith('x-')) return 'literal';
  if (key === 'examples') return 'example-map';
  if (key === 'headers') return 'named-map';
  if (key === 'schema') return 'schema';
  if (pointer === '/components' && key === 'schemas') return 'schema-map';
  return 'document';
}

/**
 * Returns a bounded, immutable snapshot shared by library, index, and query consumers.
 */
export function loadOpenApiSpec(options: LoadOpenApiSpecOptions = {}): LoadedOpenApiSpec {
  const rootInput = options.rootDir?.trim() || process.cwd();
  const root = assertWorkspaceRoot(rootInput, options.allowedRootDir);
  const entry = discoverSpec(root, rootInput, options.specPath);
  const snapshots = new Map<string, FileSnapshot>();
  let remainingBytes = MAX_SPEC_BYTES;

  function snapshot(path: string): FileSnapshot {
    const existing = snapshots.get(path);
    if (existing) return existing;
    if (snapshots.size >= MAX_SPEC_FILES) throw new Error(`SPEC_LIMIT: At most ${MAX_SPEC_FILES} source files are supported.`);
    const loaded = readBoundedFileSnapshot(path, remainingBytes);
    remainingBytes -= loaded.size;
    snapshots.set(path, loaded);
    return loaded;
  }

  const cacheId = `${root}\0${entry}`;
  const cached = specCache.get(cacheId);
  if (cached?.loaded.rootDir === root) {
    let fresh = false;
    try {
      const locationsMatch = [...cached.locations].every(([alias, canonical]) =>
        resolveFile(alias, root, root)?.canonical === canonical
      );
      fresh = locationsMatch && cached.loaded.dependencies.every((dependency) => {
        // Fast-path O(1) stat check avoids re-reading and hashing unchanged files on every query.
        const st = statSync(dependency.filePath);
        if (st.mtimeMs === dependency.mtimeMs && st.ctimeMs === dependency.ctimeMs && st.size === dependency.size) {
          return true;
        }
        const { mtimeMs, sha256 } = snapshot(dependency.filePath).fingerprint;
        return mtimeMs === dependency.mtimeMs && sha256 === dependency.sha256;
      });
    } catch (error) {
      if (!isMissing(error) && !(error instanceof Error && error.message.startsWith('SPEC_CHANGED:'))) {
        throw error;
      }
      fresh = false;
    }
    specCache.delete(cacheId);
    if (fresh) {
      specCache.set(cacheId, cached);
      return { ...cached.loaded, fromCache: true };
    }
    // Reset snapshot accounting so deleted/unused dependencies from the stale cache do not consume byte budget.
    snapshots.clear();
    remainingBytes = MAX_SPEC_BYTES;
  }

  const parsedFiles = new Map<string, unknown>();
  const fileSourceLocations = new Map<string, Map<string, SourceLocation>>();
  const locations = new Map<string, string>();
  function parseFile(path: string): unknown {
    if (parsedFiles.has(path)) return parsedFiles.get(path);
    const file = snapshot(path);
    try {
      const relFile = relative(root, path).replace(/\\/g, '/');
      const parsedDoc = parseDocumentWithLocations(file.content, relFile);
      parsedFiles.set(path, parsedDoc.value);
      fileSourceLocations.set(path, parsedDoc.locations);
      return parsedDoc.value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`SPEC_PARSE_ERROR: Failed to parse '${path}': ${message.slice(0, 400)}`);
    }
  }

  const document = parseFile(entry);
  if (!isRecord(document)) throw new Error(`SPEC_PARSE_ERROR: Entry specification '${entry}' must be an object.`);
  const schema31 = typeof document.openapi === 'string' && /^3\.(?:[1-9]|\d{2,})\./.test(document.openapi);
  const ancestors = new WeakSet<object>();
  const schemaUsageMap = new Map<string, Map<string, SchemaUsageRef>>();
  let visits = 0;
  let expandedBytes = 0;

  function recordSchemaUsage(schemaName: string, opCtx: OperationContext | undefined): void {
    if (!opCtx) return;
    const section = opCtx.section ?? 'operation';
    const key = `${opCtx.method} ${opCtx.path}\0${section}`;
    let usages = schemaUsageMap.get(schemaName);
    if (!usages) {
      usages = new Map<string, SchemaUsageRef>();
      schemaUsageMap.set(schemaName, usages);
    }
    if (!usages.has(key)) {
      usages.set(key, { method: opCtx.method, path: opCtx.path, section });
    }
  }

  function countBytes(bytes: number): void {
    expandedBytes += bytes;
    if (expandedBytes > MAX_SPEC_BYTES) throw new Error(`SPEC_LIMIT: Expanded spec exceeds ${MAX_SPEC_BYTES} bytes.`);
  }

  function expand(
    node: unknown,
    file: string,
    pointer: string,
    depth: number,
    position: Position,
    opCtx?: OperationContext
  ): unknown {
    if (++visits > MAX_NODE_VISITS || depth > MAX_DEPTH) {
      throw new Error(`SPEC_LIMIT: Spec expansion exceeds ${MAX_NODE_VISITS} nodes or ${MAX_DEPTH} levels.`);
    }
    countBytes(4);
    if (node === null || typeof node !== 'object') {
      if (typeof node === 'string' || typeof node === 'number') {
        if (typeof node === 'number' && !Number.isFinite(node)) {
          throw new Error(`SPEC_PARSE_ERROR: Non-finite number at '${pointer}'.`);
        }
        countBytes(Buffer.byteLength(JSON.stringify(node)));
      }
      return Object.is(node, -0) ? 0 : node;
    }
    if (ancestors.has(node)) return `[Circular: #${pointer}]`;
    ancestors.add(node);
    try {
      if (Array.isArray(node)) {
        const itemPosition = position === 'schema-list' ? 'schema' : position;
        return node.map((item, index) => expand(item, file, `${pointer}/${index}`, depth + 1, itemPosition, opCtx));
      }

      const prototype = Object.getPrototypeOf(node);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`SPEC_PARSE_ERROR: Expected a JSON object at '${pointer}'.`);
      }
      const object = node as Record<string, unknown>;
      if (schema31 && position === 'schema' && ('$id' in object || '$dynamicRef' in object)) {
        throw new Error('INVALID_REF: Schema resource identifiers ($id) and dynamic references ($dynamicRef) are unsupported.');
      }
      const ref = position !== 'literal' && typeof object.$ref === 'string' ? object.$ref.trim() : undefined;
      const siblings = Object.entries(object).filter(([key]) => ref === undefined || key !== '$ref');
      const inEntryFile = file === entry;
      const expandEntries = (entries: [string, unknown][]) => Object.fromEntries(entries.map(([key, value]) => {
        countBytes(Buffer.byteLength(JSON.stringify(key)));
        const escaped = key.replace(/~/g, '~0').replace(/\//g, '~1');
        const next = position === 'literal' ? 'literal' : childPosition(position, key, pointer);
        const nextOp = nextOperationContext(opCtx, inEntryFile, pointer, key);
        return [key, expand(value, file, `${pointer}/${escaped}`, depth + 1, next, nextOp)];
      }));

      if (ref === undefined) return expandEntries(siblings);
      const hash = ref.indexOf('#');
      const path = hash < 0 ? ref : ref.slice(0, hash);
      const fragment = hash < 0 ? '' : ref.slice(hash + 1);
      let targetFile = file;
      if (path) {
        const location = resolveFile(path, root, dirname(file));
        if (!location) throw new MissingReferenceError(path, file);
        locations.set(location.candidate, location.canonical);
        targetFile = location.canonical;
      }
      if (targetFile === entry && opCtx) {
        const schemaName = extractLocalSchemaName(fragment);
        if (schemaName) recordSchemaUsage(schemaName, opCtx);
      }
      const target = resolvePointer(parseFile(targetFile), fragment, ref);
      if (target !== null && typeof target === 'object' && ancestors.has(target)) {
        countBytes(Buffer.byteLength(ref));
        return `[Circular: ${ref}]`;
      }

      const resolved = expand(target, targetFile, fragment, depth + 1, position, opCtx);
      if (siblings.length === 0) return resolved;

      if (schema31 && position === 'schema') {
        if (siblings.some(([key]) => !annotations.has(key)) || !isRecord(resolved)) {
          const local = expandEntries(siblings);
          if (local.allOf !== undefined && !Array.isArray(local.allOf)) {
            throw new Error('INVALID_REF: Schema keyword allOf must be an array.');
          }
          // Keep local keywords adjacent to the reference applicator. In particular,
          // unevaluatedProperties can observe properties evaluated by that applicator.
          return { ...local, allOf: [resolved, ...(local.allOf ?? [])] };
        }
      }
      return isRecord(resolved) ? { ...resolved, ...expandEntries(siblings) } : resolved;
    } finally {
      ancestors.delete(node);
    }
  }

  const resolved = expand(document, entry, '', 0, 'document');
  if (!isRecord(resolved)) throw new Error('SPEC_PARSE_ERROR: Resolved entry specification must be an object.');
  const spec = deepFreeze(resolved);
  snapshotJson.set(spec, serializeSpec(spec));
  const dependencies = [...parsedFiles.keys()].map((path) => snapshot(path).fingerprint);
  const cacheKey = createHash('sha256').update(JSON.stringify(dependencies)).digest('hex');

  const entryLocations = fileSourceLocations.get(entry);
  const sourceLocations: Record<string, SourceLocation> = entryLocations
    ? Object.fromEntries(entryLocations.entries())
    : {};
  const schemaUsages: Record<string, SchemaUsageRef[]> = {};
  for (const [schemaName, usages] of schemaUsageMap.entries()) {
    schemaUsages[schemaName] = [...usages.values()].sort((a, b) =>
      `${a.method} ${a.path} ${a.section}`.localeCompare(`${b.method} ${b.path} ${b.section}`)
    );
  }

  // Freeze the cache's validation inputs and metadata so library callers cannot mutate them.
  deepFreeze(dependencies);
  deepFreeze(sourceLocations);
  deepFreeze(schemaUsages);
  const loaded = { spec, specPath: entry, rootDir: root, dependencies, cacheKey, sourceLocations, schemaUsages };
  specCache.set(cacheId, { loaded, locations });
  if (specCache.size > MAX_CACHED_SPECS) specCache.delete(specCache.keys().next().value!);
  return { ...loaded, fromCache: false };
}

export function clearSpecCache(): void {
  specCache.clear();
}

export function getSpecCacheStats(): { size: number; entries: string[] } {
  return { size: specCache.size, entries: [...specCache.keys()] };
}
