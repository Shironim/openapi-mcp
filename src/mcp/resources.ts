import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MAX_RESULT_BYTES } from '../engine/budget.js';
import {
  DEFAULT_SPEC_CANDIDATES,
  buildEndpointIndex,
  buildSchemaIndex,
  diagnoseOpenApiSpec,
  scanWorkspaceSpecs,
  searchEndpoints,
  searchSchemas,
  type LoadedOpenApiSpec,
} from '../engine/index.js';

const INDEX_URI = 'openapi://endpoints/index';
const SEARCH_URI = 'openapi://endpoints/search';
const SCHEMAS_INDEX_URI = 'openapi://schemas/index';
const SCHEMAS_SEARCH_URI = 'openapi://schemas/search';
const DIAGNOSTICS_URI = 'openapi://spec/diagnostics';
const CATALOG_URI = 'openapi://specs/catalog';
const INDEX_SOFT_MAX_BYTES = 64 * 1024;

const SpecParams = z.strictObject({ spec_path: z.string().trim().min(1).optional() });
const BooleanParam = z.enum(['true', 'false']).transform((v) => v === 'true');
const PaginationParams = {
  offset: z.string().regex(/^\d+$/).pipe(z.coerce.number<string>().int().nonnegative()).default(0),
  limit: z.string().regex(/^\d+$/).pipe(z.coerce.number<string>().int().min(1).max(100)).default(20),
};
const SearchParams = SpecParams.extend({
  q: z.string().trim().optional(),
  tag: z.string().trim().optional(),
  method: z.string().trim().min(1).optional(),
  pathPrefix: z.string().trim().min(1).optional(),
  operationId: z.string().trim().optional(),
  missingErrorContracts: BooleanParam.optional(),
  ...PaginationParams,
});
const SchemaSearchParams = SpecParams.extend({
  q: z.string().trim().optional(),
  usedByPath: z.string().trim().optional(),
  unusedOnly: BooleanParam.optional(),
  ...PaginationParams,
});

export const OPENAPI_RESOURCES = [
  {
    uri: INDEX_URI,
    name: 'OpenAPI Endpoints Index',
    description:
      'Compact index of all OpenAPI endpoints in `METHOD /path — summary — [200, 400, 404, 422, 500]` format, including all 4xx/5xx error status codes, auth schemes, and source locations.',
    mimeType: 'application/json',
  },
  {
    uri: SCHEMAS_INDEX_URI,
    name: 'OpenAPI Component Schemas Index',
    description:
      'Compact index of `components.schemas` (or Swagger `definitions`) with required fields, property keys, source locations, and reverse references (`usedBy`) to endpoints.',
    mimeType: 'application/json',
  },
  {
    uri: DIAGNOSTICS_URI,
    name: 'OpenAPI Spec Diagnostics',
    description:
      'Multi-issue validation & contract quality report: broken $refs, duplicate operationIds, undeclared path params, unknown security schemes, and missing error contracts.',
    mimeType: 'application/json',
  },
  {
    uri: CATALOG_URI,
    name: 'Workspace OpenAPI files',
    description: 'List conventional entry filenames relative to the workspace root.',
    mimeType: 'application/json',
  },
] as const;

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: SEARCH_URI + '{?q,tag,method,pathPrefix,operationId,missingErrorContracts,offset,limit,spec_path}',
    name: 'Search endpoint index',
    description:
      'Search method, path, summary, tags or operationId by substring. Optional exact tag, method, pathPrefix, operationId, and missingErrorContracts filters. Case-insensitive. Follow nextUri for more.',
    mimeType: 'application/json',
  },
  { uriTemplate: INDEX_URI + '{?spec_path}', name: 'Selected endpoint index', mimeType: 'application/json' },
  {
    uriTemplate: SCHEMAS_SEARCH_URI + '{?q,usedByPath,unusedOnly,offset,limit,spec_path}',
    name: 'Search component schemas',
    description:
      'Search components.schemas by name, property, or description, filter by endpoint path usage or unused schemas. Follow nextUri for more.',
    mimeType: 'application/json',
  },
  { uriTemplate: SCHEMAS_INDEX_URI + '{?spec_path}', name: 'Selected component schemas index', mimeType: 'application/json' },
  { uriTemplate: DIAGNOSTICS_URI + '{?spec_path}', name: 'Selected spec diagnostics', mimeType: 'application/json' },
] as const;

function jsonResource(uri: string, text: string) {
  return { contents: [{ uri, mimeType: 'application/json', text }] };
}

function buildPaginatedResponse<T>(
  uri: string,
  url: URL,
  page: T & { totalMatches: number },
  pageLength: number,
  offset: number,
  limitErrorMessage: string
) {
  const next = offset + pageLength;
  url.searchParams.set('offset', String(next));
  const text = JSON.stringify({ ...page, nextUri: next < page.totalMatches ? url.href : null });
  if (Buffer.byteLength(text) > MAX_RESULT_BYTES) {
    throw new Error(limitErrorMessage);
  }
  return jsonResource(uri, text);
}

function buildSoftCappedIndexResponse(
  uri: string,
  url: URL,
  payload: unknown,
  itemCount: number,
  itemLabel: string,
  filterHint: string
) {
  const text = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(text) > INDEX_SOFT_MAX_BYTES) {
    url.pathname = '/search';
    url.searchParams.set('limit', '20');
    throw new Error(
      `INDEX_LIMIT: Full ${itemLabel} index exceeds ${INDEX_SOFT_MAX_BYTES} bytes (${itemCount} ${itemLabel}s). Read ${url.href} and follow nextUri or add filters (${filterHint}).`
    );
  }
  return jsonResource(uri, text);
}

export interface ResourceHandlerContext {
  defaultRoot: string;
  configuredRoot?: string;
  defaultSpec?: string;
  readSpec: (root?: string, specPath?: string) => LoadedOpenApiSpec;
}

export function registerResourceHandlers(server: Server, ctx: ResourceHandlerContext): void {
  const indexes = new WeakMap<object, ReturnType<typeof buildEndpointIndex>>();
  const schemaIndexes = new WeakMap<object, ReturnType<typeof buildSchemaIndex>>();

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: OPENAPI_RESOURCES.map((r) => ({ ...r })),
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: RESOURCE_TEMPLATES.map((t) => ({ ...t })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const isSearch = uri === SEARCH_URI || uri.startsWith(SEARCH_URI + '?');
    const isIndex = uri === INDEX_URI || uri.startsWith(INDEX_URI + '?');
    const isSchemaIndex = uri === SCHEMAS_INDEX_URI || uri.startsWith(SCHEMAS_INDEX_URI + '?');
    const isSchemaSearch = uri === SCHEMAS_SEARCH_URI || uri.startsWith(SCHEMAS_SEARCH_URI + '?');
    const isDiagnostics = uri === DIAGNOSTICS_URI || uri.startsWith(DIAGNOSTICS_URI + '?');

    if (uri === CATALOG_URI) {
      const catalog = scanWorkspaceSpecs(ctx.defaultRoot);
      const payload = catalog.skippedDirCount > 0
        ? {
            specPaths: catalog.specPaths,
            skippedDirCount: catalog.skippedDirCount,
            skippedDirs: catalog.skippedDirs,
          }
        : { specPaths: catalog.specPaths };
      const text = JSON.stringify(payload);
      if (Buffer.byteLength(text) > MAX_RESULT_BYTES) throw new Error('CATALOG_LIMIT: Select a narrower workspace root.');
      return jsonResource(uri, text);
    }

    if (!isIndex && !isSearch && !isSchemaIndex && !isSchemaSearch && !isDiagnostics) {
      throw new Error(
        `Unknown resource URI '${uri}'. Available resources: ${OPENAPI_RESOURCES.map((r) => r.uri).join(', ')}, and templates '${SEARCH_URI}{?q,tag,method,pathPrefix,operationId,missingErrorContracts,offset,limit,spec_path}', '${SCHEMAS_SEARCH_URI}{?q,usedByPath,unusedOnly,offset,limit,spec_path}', '${DIAGNOSTICS_URI}{?spec_path}'.`
      );
    }

    const url = new URL(uri);
    const params = Object.fromEntries(url.searchParams);
    const endpointFilters = isSearch ? SearchParams.parse(params) : undefined;
    const schemaFilters = isSchemaSearch ? SchemaSearchParams.parse(params) : undefined;
    const selected = endpointFilters ?? schemaFilters ?? SpecParams.parse(params);

    try {
      if (isDiagnostics) {
        const report = diagnoseOpenApiSpec({
          rootDir: ctx.defaultRoot,
          specPath: selected.spec_path ?? ctx.defaultSpec,
          allowedRootDir: ctx.configuredRoot,
        });
        const text = JSON.stringify(report, null, 2);
        if (Buffer.byteLength(text) > MAX_RESULT_BYTES) {
          throw new Error('DIAGNOSTICS_LIMIT: Diagnostics payload exceeds response byte limit.');
        }
        return jsonResource(uri, text);
      }

      const loaded = ctx.readSpec(undefined, selected.spec_path);

      if (isSchemaIndex || isSchemaSearch) {
        let schemaIndex = schemaIndexes.get(loaded.spec);
        if (!schemaIndex) {
          schemaIndex = buildSchemaIndex(loaded.spec, loaded.specPath, loaded.sourceLocations, loaded.schemaUsages);
          schemaIndexes.set(loaded.spec, schemaIndex);
        }
        if (schemaFilters) {
          const page = searchSchemas(schemaIndex.schemas, schemaFilters);
          return buildPaginatedResponse(
            uri,
            url,
            page,
            page.schemas.length,
            schemaFilters.offset,
            'INDEX_LIMIT: Reduce limit or narrow schema search filters.'
          );
        }
        return buildSoftCappedIndexResponse(
          uri,
          url,
          schemaIndex,
          schemaIndex.totalSchemas,
          'schema',
          'q, usedByPath, unusedOnly'
        );
      }

      let index = indexes.get(loaded.spec);
      if (!index) {
        index = buildEndpointIndex(loaded.spec, loaded.specPath, loaded.sourceLocations);
        indexes.set(loaded.spec, index);
      }
      if (endpointFilters) {
        const page = searchEndpoints(index.endpoints, endpointFilters);
        return buildPaginatedResponse(
          uri,
          url,
          page,
          page.endpoints.length,
          endpointFilters.offset,
          'INDEX_LIMIT: Reduce limit or narrow the filters. For a single oversized operation use openapi_query.'
        );
      }
      return buildSoftCappedIndexResponse(
        uri,
        url,
        index,
        index.totalEndpoints,
        'endpoint',
        'q, tag, method, pathPrefix'
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('SPEC_NOT_FOUND:') || message.startsWith('SPEC_FILE_NOT_FOUND:')) {
        return jsonResource(
          uri,
          JSON.stringify(
            {
              status: 'spec_not_found',
              workspaceRoot: ctx.defaultRoot,
              checkedCandidates: selected.spec_path || ctx.defaultSpec
                ? [selected.spec_path ?? ctx.defaultSpec]
                : [...DEFAULT_SPEC_CANDIDATES],
              hint: 'Read openapi://specs/catalog and select a spec_path, or configure the default spec.',
            },
            null,
            2
          )
        );
      }
      throw err;
    }
  });
}
