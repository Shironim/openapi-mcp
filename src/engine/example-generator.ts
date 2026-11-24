import { isRecord } from './json.js';
import { escapeJsonPointer, type SourceLocation } from './source-map.js';

export interface ExampleGeneratorOptions {
  maxDepth?: number;
  maxNodes?: number;
  includeReadOnly?: boolean;
  includeWriteOnly?: boolean;
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_NODES = 256;

function pickPrimaryType(typeField: unknown): string | undefined {
  if (typeof typeField === 'string') return typeField;
  if (Array.isArray(typeField)) {
    const nonNull = typeField.find((t) => typeof t === 'string' && t !== 'null');
    if (typeof nonNull === 'string') return nonNull;
    const first = typeField.find((t) => typeof t === 'string');
    if (typeof first === 'string') return first;
  }
  return undefined;
}

function synthesizeString(schema: Record<string, unknown>): string {
  const format = typeof schema.format === 'string' ? schema.format.toLowerCase() : '';
  switch (format) {
    case 'uuid':
      return '00000000-0000-4000-8000-000000000000';
    case 'email':
    case 'idn-email':
      return 'user@example.com';
    case 'date-time':
      return '2026-01-01T00:00:00Z';
    case 'date':
      return '2026-01-01';
    case 'time':
      return '00:00:00Z';
    case 'uri':
    case 'url':
    case 'iri':
      return 'https://example.com/resource';
    case 'ipv4':
      return '192.0.2.1';
    case 'ipv6':
      return '2001:db8::1';
    case 'hostname':
    case 'idn-hostname':
      return 'example.com';
    case 'byte':
      return 'ZXhhbXBsZQ==';
    default: {
      const minLen = typeof schema.minLength === 'number' && schema.minLength > 0 ? Math.min(64, Math.floor(schema.minLength)) : 0;
      const base = 'string';
      return minLen > base.length ? base.padEnd(minLen, 'x') : base;
    }
  }
}

function synthesizeNumber(schema: Record<string, unknown>, integer: boolean): number {
  const min = typeof schema.minimum === 'number' ? schema.minimum : undefined;
  const exMin = typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : undefined;
  const max = typeof schema.maximum === 'number' ? schema.maximum : undefined;

  let value = integer ? 1 : 0;
  if (exMin !== undefined) {
    value = integer ? Math.floor(exMin) + 1 : exMin + 0.5;
  } else if (min !== undefined && value < min) {
    value = integer ? Math.ceil(min) : min;
  }
  if (max !== undefined && value > max) {
    value = integer ? Math.floor(max) : max;
  }
  return value;
}

/**
 * Deterministically synthesizes a valid sample JSON value from a resolved OpenAPI 3.0/3.1 schema.
 * Safe against circular markers (`[Circular: ...]`) and bounded by depth and node count.
 */
export function generateSchemaExample(
  schema: unknown,
  options: ExampleGeneratorOptions = {}
): unknown {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const includeReadOnly = options.includeReadOnly ?? true;
  const includeWriteOnly = options.includeWriteOnly ?? true;
  let nodes = 0;

  function visit(node: unknown, depth: number): unknown {
    if (++nodes > maxNodes || depth > maxDepth) return null;
    if (typeof node === 'string' && node.startsWith('[Circular:')) return null;
    if (typeof node === 'boolean') return node ? {} : null;
    if (!isRecord(node)) return null;

    if (node.example !== undefined) return node.example;
    if (Array.isArray(node.examples) && node.examples.length > 0) return node.examples[0];
    if (node.const !== undefined) return node.const;
    if (node.default !== undefined) return node.default;
    if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];

    if (Array.isArray(node.allOf) && node.allOf.length > 0) {
      const merged: Record<string, unknown> = {};
      let anyObject = false;
      for (const branch of node.allOf) {
        const sample = visit(branch, depth + 1);
        if (isRecord(sample)) {
          Object.assign(merged, sample);
          anyObject = true;
        }
      }
      if (anyObject) return merged;
      return visit(node.allOf[0], depth + 1);
    }

    const unionBranches = Array.isArray(node.oneOf)
      ? node.oneOf
      : Array.isArray(node.anyOf)
        ? node.anyOf
        : undefined;
    if (unionBranches && unionBranches.length > 0) {
      const nonNull = unionBranches.find((b) => isRecord(b) && b.type !== 'null') ?? unionBranches[0];
      return visit(nonNull, depth + 1);
    }

    const primaryType = pickPrimaryType(node.type) ?? (isRecord(node.properties) ? 'object' : node.items !== undefined ? 'array' : undefined);
    switch (primaryType) {
      case 'object': {
        const out: Record<string, unknown> = {};
        if (isRecord(node.properties)) {
          for (const [key, propSchema] of Object.entries(node.properties)) {
            if (isRecord(propSchema)) {
              if (!includeReadOnly && propSchema.readOnly === true) continue;
              if (!includeWriteOnly && propSchema.writeOnly === true) continue;
            }
            out[key] = visit(propSchema, depth + 1);
          }
        }
        return out;
      }
      case 'array': {
        if (Array.isArray(node.prefixItems) && node.prefixItems.length > 0) {
          return node.prefixItems.map((item) => visit(item, depth + 1));
        }
        if (node.items === undefined) return [];
        const minItems = typeof node.minItems === 'number' && node.minItems > 0 ? Math.min(2, Math.floor(node.minItems)) : 1;
        const arr: unknown[] = [];
        for (let i = 0; i < minItems; i++) {
          arr.push(visit(node.items, depth + 1));
        }
        return arr;
      }
      case 'string':
        return synthesizeString(node);
      case 'integer':
        return synthesizeNumber(node, true);
      case 'number':
        return synthesizeNumber(node, false);
      case 'boolean':
        return true;
      case 'null':
        return null;
      default:
        return null;
    }
  }

  return visit(schema, 0);
}

export interface MergedOperationContract {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  security?: unknown[];
  parameters: unknown[];
  requestBody?: unknown;
  responses?: unknown;
  sourceLocation?: SourceLocation;
}

/**
 * Returns a single operation's complete contract with path-level + operation-level `parameters`
 * merged (operation overrides path on matching `name`+`in`), effective `security`, and `sourceLocation`.
 */
export function getMergedOperation(
  spec: Record<string, unknown>,
  method: string,
  path: string,
  sourceLocations?: Readonly<Record<string, SourceLocation>>
): MergedOperationContract | null {
  const paths = isRecord(spec.paths) ? spec.paths : undefined;
  const pathItem = paths && isRecord(paths[path]) ? paths[path] : undefined;
  const lowerMethod = method.trim().toLowerCase();
  const operation = pathItem && isRecord(pathItem[lowerMethod]) ? pathItem[lowerMethod] : undefined;
  if (!pathItem || !operation) return null;

  const mergedParams = new Map<string, unknown>();
  const addParams = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const param of list) {
      if (isRecord(param) && typeof param.name === 'string' && typeof param.in === 'string') {
        mergedParams.set(`${param.in}:${param.name}`, param);
      }
    }
  };
  addParams(pathItem.parameters);
  addParams(operation.parameters);

  const effectiveSecurity = Array.isArray(operation.security)
    ? operation.security
    : Array.isArray(spec.security)
      ? spec.security
      : undefined;

  const sourceLocation = sourceLocations?.[`/paths/${escapeJsonPointer(path)}/${lowerMethod}`];

  return {
    method: lowerMethod.toUpperCase(),
    path,
    ...(typeof operation.operationId === 'string' ? { operationId: operation.operationId } : {}),
    ...(typeof operation.summary === 'string' ? { summary: operation.summary } : {}),
    ...(typeof operation.description === 'string' ? { description: operation.description } : {}),
    ...(Array.isArray(operation.tags) ? { tags: operation.tags.filter((t): t is string => typeof t === 'string') } : {}),
    ...(operation.deprecated === true ? { deprecated: true } : {}),
    ...(effectiveSecurity !== undefined ? { security: effectiveSecurity } : {}),
    parameters: [...mergedParams.values()],
    ...(operation.requestBody !== undefined ? { requestBody: operation.requestBody } : {}),
    ...(operation.responses !== undefined ? { responses: operation.responses } : {}),
    ...(sourceLocation ? { sourceLocation } : {}),
  };
}

function pickMediaContent(content: Record<string, unknown>): { mediaType: string; media: Record<string, unknown> } | undefined {
  if (isRecord(content['application/json'])) {
    return { mediaType: 'application/json', media: content['application/json'] };
  }
  const jsonLike = Object.keys(content).find((k) => k.includes('json') && isRecord(content[k]));
  if (jsonLike) return { mediaType: jsonLike, media: content[jsonLike] as Record<string, unknown> };
  const firstKey = Object.keys(content).find((k) => isRecord(content[k]));
  if (firstKey) return { mediaType: firstKey, media: content[firstKey] as Record<string, unknown> };
  return undefined;
}

function extractMediaExample(media: Record<string, unknown>, opts: ExampleGeneratorOptions): unknown {
  if (media.example !== undefined) return media.example;
  if (isRecord(media.examples)) {
    for (const ex of Object.values(media.examples)) {
      if (isRecord(ex) && ex.value !== undefined) return ex.value;
    }
  }
  if (media.schema !== undefined) return generateSchemaExample(media.schema, opts);
  return null;
}

/**
 * Generates deterministic request and response sample payloads for a given `method` + `path`
 * (optionally filtered to a single response `statusCode`).
 */
export function generateOperationExamples(
  spec: Record<string, unknown>,
  method: string,
  path: string,
  statusCode?: string
): {
  method: string;
  path: string;
  requestBody?: { mediaType: string; example: unknown };
  responses: Record<string, { mediaType?: string; example: unknown }>;
} | null {
  const op = getMergedOperation(spec, method, path);
  if (!op) return null;

  let requestBody: { mediaType: string; example: unknown } | undefined;
  if (isRecord(op.requestBody) && isRecord(op.requestBody.content)) {
    const picked = pickMediaContent(op.requestBody.content);
    if (picked) {
      requestBody = {
        mediaType: picked.mediaType,
        example: extractMediaExample(picked.media, { includeReadOnly: false, includeWriteOnly: true }),
      };
    }
  }

  const responses: Record<string, { mediaType?: string; example: unknown }> = {};
  if (isRecord(op.responses)) {
    const codes = statusCode ? [statusCode] : Object.keys(op.responses);
    for (const code of codes) {
      const res = op.responses[code];
      if (!isRecord(res)) continue;
      if (isRecord(res.content)) {
        const picked = pickMediaContent(res.content);
        if (picked) {
          responses[code] = {
            mediaType: picked.mediaType,
            example: extractMediaExample(picked.media, { includeReadOnly: true, includeWriteOnly: false }),
          };
          continue;
        }
      }
      if (res.schema !== undefined) {
        responses[code] = {
          example: generateSchemaExample(res.schema, { includeReadOnly: true, includeWriteOnly: false }),
        };
      }
    }
  }

  return {
    method: op.method,
    path: op.path,
    ...(requestBody ? { requestBody } : {}),
    responses,
  };
}
