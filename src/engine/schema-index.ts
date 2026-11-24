import { isRecord } from './json.js';
import { escapeJsonPointer, type SourceLocation } from './source-map.js';

const MAX_LISTED_PROPERTIES = 40;
const MAX_LISTED_ENUM = 20;

export interface SchemaUsageRef {
  method: string;
  path: string;
  section: string;
}

export interface SchemaSummaryItem {
  name: string;
  type: string;
  description?: string;
  required?: string[];
  properties?: string[];
  totalProperties?: number;
  enumValues?: unknown[];
  usedBy: string[];
  sourceLocation?: SourceLocation;
}

export interface SchemaIndex {
  title: string;
  version: string;
  openapiVersion: string;
  specPath?: string;
  totalSchemas: number;
  unusedSchemas: string[];
  schemas: SchemaSummaryItem[];
}

export interface SchemaSearchFilters {
  q?: string;
  usedByPath?: string;
  unusedOnly?: boolean;
  offset: number;
  limit: number;
}

function inferSchemaType(schema: unknown): string {
  if (typeof schema === 'boolean') return schema ? 'any' : 'never';
  if (!isRecord(schema)) return 'unknown';
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t): t is string => typeof t === 'string');
    if (types.length > 0) return types.join(' | ');
  }
  if (Array.isArray(schema.oneOf)) return 'oneOf';
  if (Array.isArray(schema.anyOf)) return 'anyOf';
  if (Array.isArray(schema.allOf)) return 'allOf';
  if (Array.isArray(schema.enum)) return 'enum';
  if (isRecord(schema.properties)) return 'object';
  if (schema.items !== undefined) return 'array';
  return 'unknown';
}

function collectObjectProperties(schema: unknown): { properties: string[]; required: Set<string> } {
  const properties = new Set<string>();
  const required = new Set<string>();

  const visit = (node: unknown, depth: number) => {
    if (depth > 4 || !isRecord(node)) return;
    if (isRecord(node.properties)) {
      for (const key of Object.keys(node.properties)) properties.add(key);
    }
    if (Array.isArray(node.required)) {
      for (const req of node.required) {
        if (typeof req === 'string' && req.trim()) required.add(req);
      }
    }
    if (Array.isArray(node.allOf)) {
      for (const branch of node.allOf) visit(branch, depth + 1);
    }
  };

  visit(schema, 0);
  return { properties: [...properties], required };
}

function formatUsage(usage: SchemaUsageRef): string {
  return `${usage.method} ${usage.path} (${usage.section})`;
}

/**
 * Builds a compact index of `components.schemas` (OpenAPI 3.x) or `definitions` (Swagger 2.0),
 * enriched with reverse references (`usedBy`) and YAML/JSON `sourceLocation`.
 */
export function buildSchemaIndex(
  spec: Record<string, unknown>,
  specPath?: string,
  sourceLocations?: Readonly<Record<string, SourceLocation>>,
  schemaUsages?: Readonly<Record<string, readonly SchemaUsageRef[]>>
): SchemaIndex {
  const info = isRecord(spec.info) ? spec.info : {};
  const title = typeof info.title === 'string' && info.title.trim() ? info.title.trim() : 'Untitled API';
  const version = typeof info.version === 'string' && info.version.trim() ? info.version.trim() : 'unknown';
  const openapiVersion =
    typeof spec.openapi === 'string'
      ? spec.openapi
      : typeof spec.swagger === 'string'
        ? spec.swagger
        : 'unknown';

  const components = isRecord(spec.components) ? spec.components : undefined;
  const schemasObj = isRecord(components?.schemas)
    ? components.schemas
    : isRecord(spec.definitions)
      ? spec.definitions
      : {};
  const pointerBase = isRecord(components?.schemas) ? '/components/schemas' : '/definitions';

  const schemas: SchemaSummaryItem[] = [];
  const unusedSchemas: string[] = [];

  for (const name of Object.keys(schemasObj).sort()) {
    const schema = schemasObj[name];
    const type = inferSchemaType(schema);
    const description =
      isRecord(schema) && typeof schema.description === 'string' && schema.description.trim()
        ? schema.description.trim().split(/\r?\n/)[0]!.trim().slice(0, 140)
        : undefined;

    const { properties, required } = collectObjectProperties(schema);
    const reqList = [...required].sort();
    const enumValues =
      isRecord(schema) && Array.isArray(schema.enum)
        ? schema.enum.slice(0, MAX_LISTED_ENUM)
        : undefined;

    const usages = schemaUsages?.[name] ?? [];
    const usedBy = usages.map(formatUsage);
    if (usedBy.length === 0) unusedSchemas.push(name);

    const sourceLocation = sourceLocations?.[`${pointerBase}/${escapeJsonPointer(name)}`];

    schemas.push({
      name,
      type,
      ...(description ? { description } : {}),
      ...(reqList.length > 0 ? { required: reqList } : {}),
      ...(properties.length > 0
        ? {
            properties: properties.slice(0, MAX_LISTED_PROPERTIES),
            ...(properties.length > MAX_LISTED_PROPERTIES ? { totalProperties: properties.length } : {}),
          }
        : {}),
      ...(enumValues && enumValues.length > 0 ? { enumValues } : {}),
      usedBy,
      ...(sourceLocation ? { sourceLocation } : {}),
    });
  }

  return {
    title,
    version,
    openapiVersion,
    ...(specPath ? { specPath } : {}),
    totalSchemas: schemas.length,
    unusedSchemas,
    schemas,
  };
}

export function searchSchemas(entries: SchemaSummaryItem[], filters: SchemaSearchFilters) {
  const query = filters.q?.toLowerCase();
  const usedByPath = filters.usedByPath?.toLowerCase();
  const schemas: SchemaSummaryItem[] = [];
  let totalMatches = 0;

  for (const entry of entries) {
    if (filters.unusedOnly === true && entry.usedBy.length > 0) continue;
    if (filters.unusedOnly === false && entry.usedBy.length === 0) continue;
    if (usedByPath && !entry.usedBy.some((ref) => ref.toLowerCase().includes(usedByPath))) continue;
    if (query) {
      const haystacks = [
        entry.name,
        entry.type,
        entry.description ?? '',
        ...(entry.properties ?? []),
        ...(entry.required ?? []),
      ];
      if (!haystacks.some((value) => value.toLowerCase().includes(query))) continue;
    }
    if (totalMatches >= filters.offset && schemas.length < filters.limit) {
      schemas.push(entry);
    }
    totalMatches++;
  }

  return { schemas, totalMatches };
}
