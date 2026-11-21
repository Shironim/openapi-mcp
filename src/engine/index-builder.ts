import { isRecord } from './json.js';

export const HTTP_METHODS = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
  'trace',
] as const;

export interface EndpointSummaryItem {
  method: string;
  path: string;
  operationId?: string;
  summary: string;
  tags?: string[];
  statusCodes: string[];
  errorStatusCodes: string[];
  errorBodies: Record<string, { schemaMediaTypes: string[]; hasSwaggerSchema?: boolean }>;
  line: string;
}

export interface EndpointIndex {
  title: string;
  version: string;
  openapiVersion: string;
  specPath?: string;
  totalEndpoints: number;
  endpointsWithErrorContracts: number;
  endpointsMissingErrorContracts: string[];
  lines: string[];
  endpoints: EndpointSummaryItem[];
}

function sortStatusCodes(codes: string[]): string[] {
  return [...codes].sort((a, b) => {
    const aNum = /^\d+$/.test(a) ? Number(a) : Number.POSITIVE_INFINITY;
    const bNum = /^\d+$/.test(b) ? Number(b) : Number.POSITIVE_INFINITY;
    if (aNum !== bNum) return aNum - bNum;
    if (a === 'default') return 1;
    if (b === 'default') return -1;
    return a.localeCompare(b);
  });
}

export function searchEndpoints(entries: EndpointSummaryItem[], filters: {
  q?: string; tag?: string; operationId?: string; offset: number; limit: number;
}) {
  const query = filters.q?.toLowerCase();
  const tag = filters.tag?.toLowerCase();
  const operationId = filters.operationId?.toLowerCase();
  const endpoints: EndpointSummaryItem[] = [];
  let totalMatches = 0;
  for (const entry of entries) {
    const tags = entry.tags ?? [];
    if (tag && !tags.some(value => value.toLowerCase() === tag)) continue;
    if (operationId && entry.operationId?.toLowerCase() !== operationId) continue;
    if (query && ![entry.method, entry.path, entry.summary, entry.operationId ?? '', ...tags]
      .some(value => value.toLowerCase().includes(query))) continue;
    if (totalMatches >= filters.offset && endpoints.length < filters.limit) endpoints.push(entry);
    totalMatches++;
  }
  return { endpoints, totalMatches };
}

function isErrorStatusCode(code: string): boolean {
  const normalized = code.trim().toLowerCase();
  return /^[45](?:\d{2}|xx)$/.test(normalized);
}

function extractSummary(operation: Record<string, unknown>): string {
  if (typeof operation.summary === 'string' && operation.summary.trim()) {
    return operation.summary.trim().replace(/\s+/g, ' ');
  }
  if (typeof operation.description === 'string' && operation.description.trim()) {
    const firstLine = operation.description.trim().split(/\r?\n/)[0] ?? '';
    if (firstLine.trim()) {
      return firstLine.trim().slice(0, 120);
    }
  }
  if (typeof operation.operationId === 'string' && operation.operationId.trim()) {
    return operation.operationId.trim();
  }
  return 'No summary';
}

/**
 * Builds a compact, token-lean index of all endpoints and their defined HTTP status codes
 * (including all 4xx/5xx error responses) from a resolved OpenAPI specification.
 */
export function buildEndpointIndex(spec: Record<string, unknown>, specPath?: string): EndpointIndex {
  const info = isRecord(spec.info) ? spec.info : {};
  const title = typeof info.title === 'string' && info.title.trim() ? info.title.trim() : 'Untitled API';
  const version = typeof info.version === 'string' && info.version.trim() ? info.version.trim() : 'unknown';
  const openapiVersion =
    typeof spec.openapi === 'string'
      ? spec.openapi
      : typeof spec.swagger === 'string'
        ? spec.swagger
        : 'unknown';

  const pathsObj = isRecord(spec.paths) ? spec.paths : {};
  const endpoints: EndpointSummaryItem[] = [];
  const endpointsMissingErrorContracts: string[] = [];

  for (const pathKey of Object.keys(pathsObj)) {
    const pathItem = pathsObj[pathKey];
    if (!isRecord(pathItem)) continue;

    for (const httpMethod of HTTP_METHODS) {
      const operation = pathItem[httpMethod];
      if (!isRecord(operation)) continue;

      const method = httpMethod.toUpperCase();
      const summary = extractSummary(operation);
      const responses = isRecord(operation.responses) ? operation.responses : {};
      const statusCodes = sortStatusCodes(Object.keys(responses));
      const errorStatusCodes = statusCodes.filter(isErrorStatusCode);
      const errorBodies = Object.fromEntries(errorStatusCodes.map(code => {
        const response = responses[code];
        const content = isRecord(response) && isRecord(response.content) ? response.content : {};
        const schemaMediaTypes = Object.keys(content).filter(type => {
          const media = content[type];
          return isRecord(media) && (isRecord(media.schema) || typeof media.schema === 'boolean');
        });
        const hasSwaggerSchema = spec.swagger === '2.0' && isRecord(response) && isRecord(response.schema);
        return [code, { schemaMediaTypes, ...(hasSwaggerSchema ? { hasSwaggerSchema } : {}) }];
      }));

      if (errorStatusCodes.length === 0) {
        endpointsMissingErrorContracts.push(`${method} ${pathKey}`);
      }

      const tags = Array.isArray(operation.tags)
        ? operation.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        : undefined;

      const operationId =
        typeof operation.operationId === 'string' && operation.operationId.trim()
          ? operation.operationId.trim()
          : undefined;

      const statusList = statusCodes.length > 0 ? statusCodes.join(', ') : 'none';
      const line = `${method} ${pathKey} — ${summary} — [${statusList}]`;

      endpoints.push({
        method,
        path: pathKey,
        ...(operationId ? { operationId } : {}),
        summary,
        ...(tags && tags.length > 0 ? { tags } : {}),
        statusCodes,
        errorStatusCodes,
        errorBodies,
        line,
      });
    }
  }

  return {
    title,
    version,
    openapiVersion,
    ...(specPath ? { specPath } : {}),
    totalEndpoints: endpoints.length,
    endpointsWithErrorContracts: endpoints.length - endpointsMissingErrorContracts.length,
    endpointsMissingErrorContracts,
    lines: endpoints.map((e) => e.line),
    endpoints,
  };
}
