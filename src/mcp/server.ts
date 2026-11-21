import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { listWorkspaceSpecs } from '../engine/spec-catalog.js';
import { MissingReferenceError } from '../engine/spec-loader.js';
import { searchEndpoints } from '../engine/index-builder.js';
import { z } from 'zod';
import packageInfo from '../../package.json' with { type: 'json' };
import { MAX_RESULT_BYTES, enforceSerializedByteBudget } from '../engine/budget.js';
import { isRecord } from '../engine/json.js';
import { MAX_QUERY_CODE_LENGTH, evaluateSandboxQuery } from '../engine/query-sandbox.js';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_SPEC_CANDIDATES,
  buildEndpointIndex,
  HTTP_METHODS,
  loadOpenApiSpec,
} from '../engine/index.js';

export const OPENAPI_MCP_VERSION: string = packageInfo.version;
const INDEX_URI = 'openapi://endpoints/index';
const SEARCH_URI = 'openapi://endpoints/search';
const CATALOG_URI = 'openapi://specs/catalog';
const SpecParams = z.strictObject({ spec_path: z.string().trim().min(1).optional() });
const SearchParams = SpecParams.extend({
  q: z.string().trim().optional(),
  tag: z.string().trim().optional(),
  operationId: z.string().trim().optional(),
  offset: z.string().regex(/^\d+$/).pipe(z.coerce.number<string>().int().nonnegative()).default(0),
  limit: z.string().regex(/^\d+$/).pipe(z.coerce.number<string>().int().min(1).max(100)).default(20),
});
const QUERY_NAME = 'openapi_query';
const METHOD_PREFIX = new RegExp(`^(?:${HTTP_METHODS.join('|')})\\s+`, 'i');

export const OPENAPI_MCP_INSTRUCTIONS = [
  'Use openapi-mcp in local Code Mode (index-first, query-on-demand):',
  'For monorepos read openapi://specs/catalog, then use the selected spec_path for index, search and query.',
  'Discover endpoints in the default spec with openapi://endpoints/search?q=orders&limit=20 and follow nextUri. Error status counts indicate declarations only. Check errorBodies and query the response for field details.',
  '1. Read the `openapi://endpoints/index` resource for the default specification. In a monorepo, pass the same spec_path to index, search, and openapi_query.',
  '2. Use `openapi_query` with targeted JavaScript queries against `spec` to fetch request parameters/body, `2xx` success schemas, AND all `4xx`/`5xx` error schemas (for example `spec.paths["/orders"]?.post?.responses`).',
  `3. Keep queries scoped to specific paths or component schemas. The default \`max_bytes\` is ${DEFAULT_MAX_BYTES} UTF-8 bytes of result text.`,
].join('\n');

export const OPENAPI_RESOURCES = [
  {
    uri: INDEX_URI,
    name: 'OpenAPI Endpoints Index',
    description:
      'Compact index of all OpenAPI endpoints in `METHOD /path — summary — [200, 400, 404, 422, 500]` format, including all 4xx/5xx error status codes.',
    mimeType: 'application/json',
  },
  { uri: CATALOG_URI, name: 'Workspace OpenAPI files', description: 'List conventional entry filenames relative to the workspace root.', mimeType: 'application/json' },
] as const;

export const OPENAPI_PROMPTS = [
  {
    name: 'sync-frontend-api',
    title: 'Sync Frontend API Contract',
    description:
      'Guide frontend-backend contract sync: read endpoint index, query request + 2xx + 4xx/5xx error schemas with openapi_query, and update frontend callers.',
    arguments: [
      {
        name: 'endpoint',
        description: "Optional endpoint filter or path (e.g. 'POST /orders' or '/users').",
        required: false,
      },
    ],
  },
  {
    name: 'audit-error-contracts',
    title: 'Audit OpenAPI Error Contracts',
    description:
      'Audit completeness and schema consistency of 4xx/5xx error responses across openapi.yml endpoints.',
    arguments: [
      {
        name: 'endpoint',
        description: "Optional endpoint filter or path (e.g. 'POST /orders' or '/users') to scope the audit.",
        required: false,
      },
    ],
  },
] as const;

const QueryArgsSchema = z.strictObject({
  code: z.string().regex(/\S/).max(MAX_QUERY_CODE_LENGTH).describe(
    "JavaScript expression or function body evaluated against spec, e.g. spec.paths['/users']?.get?.responses."
  ),
  spec_path: z.string().regex(/\S/).optional().describe('Optional path to the OpenAPI spec inside the selected workspace.'),
  root: z.string().regex(/\S/).optional().describe('Workspace for this query. When a server root is configured, this path must remain within it.'),
  max_bytes: z.number().int().min(1).max(MAX_RESULT_BYTES).optional().describe(
    `UTF-8 budget for successful query JSON (default: ${DEFAULT_MAX_BYTES}).`
  ),
});

export const OPENAPI_TOOLS = [
  {
    name: QUERY_NAME,
    description:
      'Query the resolved, read-only OpenAPI spec using synchronous JavaScript. Inspect the default endpoint index or query a specific path, request schema, or response schema.',
    inputSchema: z.toJSONSchema(QueryArgsSchema),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
] as const;

export interface OpenApiMcpServerOptions {
  defaultRootDir?: string;
  defaultSpecPath?: string;
}

function buildActionableToolError(err: unknown): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  const rawMessage = err instanceof Error ? err.message : String(err);

  if (err instanceof MissingReferenceError) {
    return { isError: true, content: [{ type: 'text', text: err.message }] };
  }
  let recoveryHint: string;
  if (rawMessage.startsWith('SPEC_NOT_FOUND:') || rawMessage.startsWith('SPEC_FILE_NOT_FOUND:')) {
    recoveryHint =
      'Pass `root` pointing to the repository root and/or `spec_path` (e.g. `spec_path: "api/openapi.yml"`).';
  } else if (rawMessage.startsWith('PATH_TRAVERSAL_DENIED:') || rawMessage.startsWith('REMOTE_REF_DENIED:')) {
    recoveryHint =
      'Ensure `spec_path` and all `$ref` targets remain local files inside the configured workspace `root`.';
  } else if (rawMessage.startsWith('SANDBOX_FORBIDDEN_API:')) {
    recoveryHint =
      'Use pure synchronous JS reads on `spec` without Node/Bun/network globals, e.g. `{ code: "spec.paths[\'/users\']?.get?.responses" }`.';
  } else if (rawMessage.startsWith('SANDBOX_TIMEOUT:')) {
    recoveryHint =
      'Avoid unbounded loops or scanning huge trees; target a single endpoint or schema key, e.g. `{ code: "Object.keys(spec.paths ?? {})" }`.';
  } else if (rawMessage.startsWith('SANDBOX_SYNTAX_ERROR:') || rawMessage.startsWith('SANDBOX_RUNTIME_ERROR:')) {
    recoveryHint =
      'Check endpoint/schema keys via `openapi://endpoints/index` or `{ code: "Object.keys(spec.paths ?? {})" }`, then retry with valid JS such as `{ code: "spec.paths[\'/users\']?.post" }`.';
  } else {
    recoveryHint =
      'Verify arguments (`code`, optional `spec_path`, `root`, `max_bytes`). Example: `openapi_query({ code: "spec.paths[\'/users\']?.get?.responses" })`.';
  }

  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `${rawMessage}\n\nNext step: ${recoveryHint}`,
      },
    ],
  };
}

export function getOpenApiPrompt(
  name: string,
  args: Record<string, string | undefined> = {}
) {
  const endpoint = args.endpoint?.trim();
  const pathLookup = endpoint ? `spec.paths[${JSON.stringify(endpoint.replace(METHOD_PREFIX, ''))}]` : undefined;

  switch (name) {
    case 'sync-frontend-api': {
      const targetLabel = endpoint ? `for '${endpoint}'` : 'for the target endpoint';
      const querySnippet = pathLookup ?? "spec.paths['/your-endpoint']";

      return {
        description:
          'Frontend–backend API contract synchronization workflow covering request, 2xx success, and 4xx/5xx error contracts.',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                `Synchronize frontend API integration ${targetLabel} using the OpenAPI spec as SSOT:`,
                '1. Read resource `openapi://endpoints/index` first to verify exact path, HTTP method, and all declared status codes (`2xx`, `4xx`, `5xx`).',
                `2. Call \`openapi_query\` with \`code\`, and optional \`spec_path\` / \`root\` / \`max_bytes\` to inspect the path-level parameters and operation contract (${querySnippet}) — explicitly capturing \`parameters\`, \`requestBody\`, \`2xx\` responses, AND every \`4xx\`/\`5xx\` error schema.`,
                '3. Compare request payloads, success DTOs, and error handling branches (status codes, error codes, ProblemDetails/validation fields) in the frontend codebase against the queried OpenAPI contract and align any mismatches.',
              ].join('\n'),
            },
          },
        ],
      };
    }

    case 'audit-error-contracts': {
      const scopeLabel = endpoint ? `for endpoint '${endpoint}'` : 'across all endpoints';
      const queryExample = pathLookup ??
        'Object.entries(spec.paths ?? {}).map(([path, item]) => ({ path, methods: Object.keys(item ?? {}) }))';

      return {
        description:
          'Audit completeness and consistency of 4xx/5xx error response contracts in the OpenAPI specification.',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                `Audit 4xx/5xx error contracts ${scopeLabel}:`,
                '1. Read resource `openapi://endpoints/index` and inspect `endpointsMissingErrorContracts` and each endpoint\'s `errorStatusCodes`.',
                `2. Call \`openapi_query\` with \`code\` (and optional \`spec_path\` / \`root\` / \`max_bytes\`) to inspect error response schemas (e.g. \`${queryExample}\`) and verify consistent error structures (such as ProblemDetails / validation error fields) for 400, 401, 403, 404, 422, and 500 responses.`,
                '3. Summarize gaps, missing status codes, and schema inconsistencies with concrete remediation steps.',
              ].join('\n'),
            },
          },
        ],
      };
    }

    default:
      throw new Error(
        `Unknown prompt '${name}'. Available prompts: ${OPENAPI_PROMPTS.map((p) => p.name).join(', ')}.`
      );
  }
}

export function createOpenApiMcpServer(options: OpenApiMcpServerOptions = {}): Server {
  const configuredRoot = options.defaultRootDir?.trim() || undefined;
  const defaultRoot = configuredRoot ?? process.cwd();
  const defaultSpec = options.defaultSpecPath?.trim() || undefined;

  function readSpec(root?: string, specPath?: string) {
    return loadOpenApiSpec({
      rootDir: root ?? defaultRoot,
      specPath: specPath ?? (root ? undefined : defaultSpec),
      allowedRootDir: configuredRoot,
    });
  }

  const indexes = new WeakMap<object, ReturnType<typeof buildEndpointIndex>>();
  const server = new Server(
    {
      name: 'openapi-mcp',
      version: OPENAPI_MCP_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions: OPENAPI_MCP_INSTRUCTIONS,
    }
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: OPENAPI_RESOURCES.map((r) => ({ ...r })),
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{
      uriTemplate: SEARCH_URI + '{?q,tag,operationId,offset,limit,spec_path}',
      name: 'Search endpoint index',
      description: 'Search method, path, summary, tags or operationId by substring. Optional exact tag and operationId filters. Case-insensitive. Follow nextUri for more.',
      mimeType: 'application/json',
    }, { uriTemplate: INDEX_URI + '{?spec_path}', name: 'Selected endpoint index', mimeType: 'application/json' }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const isSearch = uri === SEARCH_URI || uri.startsWith(SEARCH_URI + '?');
    if (uri === CATALOG_URI) {
      const text = JSON.stringify({ specPaths: listWorkspaceSpecs(defaultRoot) });
      if (Buffer.byteLength(text) > MAX_RESULT_BYTES) throw new Error('CATALOG_LIMIT: Select a narrower workspace root.');
      return { contents: [{ uri, mimeType: 'application/json', text }] };
    }
    if (uri !== INDEX_URI && !uri.startsWith(INDEX_URI + '?') && !isSearch) {
      throw new Error(
        `Unknown resource URI '${uri}'. Available resources: ${OPENAPI_RESOURCES.map((r) => r.uri).join(', ')}.`
      );
    }

    const url = new URL(uri);
    const params = Object.fromEntries(url.searchParams);
    const filters = isSearch ? SearchParams.parse(params) : undefined;
    const selected = filters ?? SpecParams.parse(params);
    try {
      const loaded = readSpec(undefined, selected.spec_path);
      let index = indexes.get(loaded.spec);
      if (!index) {
        index = buildEndpointIndex(loaded.spec, loaded.specPath);
        indexes.set(loaded.spec, index);
      }
      if (filters) {
        const page = searchEndpoints(index.endpoints, filters);
        const next = filters.offset + page.endpoints.length;
        url.searchParams.set('offset', String(next));
        const text = JSON.stringify({ ...page, nextUri: next < page.totalMatches ? url.href : null });
        if (Buffer.byteLength(text) > MAX_RESULT_BYTES) {
          throw new Error('INDEX_LIMIT: Reduce limit or narrow the filters. For a single oversized operation use openapi_query.');
        }
        return { contents: [{ uri, mimeType: 'application/json', text }] };
      }
      const indexText = JSON.stringify(index, null, 2);
      if (Buffer.byteLength(indexText) > MAX_RESULT_BYTES) {
        url.pathname = '/search';
        url.searchParams.set('limit', '20');
        throw new Error(`INDEX_LIMIT: Read ${url.href} and follow nextUri or add search filters.`);
      }
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: indexText,
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('SPEC_NOT_FOUND:') || message.startsWith('SPEC_FILE_NOT_FOUND:')) {
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(
                {
                  status: 'spec_not_found',
                  workspaceRoot: defaultRoot,
                  checkedCandidates: selected.spec_path || defaultSpec ? [selected.spec_path ?? defaultSpec] : [...DEFAULT_SPEC_CANDIDATES],
                  hint: 'Read openapi://specs/catalog and select a spec_path, or configure the default spec.',
                },
                null,
                2
              ),
            },
          ],
        };
      }
      throw err;
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: OPENAPI_PROMPTS.map((p) => ({
        name: p.name,
        title: p.title,
        description: p.description,
        arguments: p.arguments.map((a) => ({ ...a })),
      })),
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    return getOpenApiPrompt(request.params.name, request.params.arguments);
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: OPENAPI_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: { ...t.annotations },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;

    if (name !== QUERY_NAME) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `Unknown tool '${name}'. Available tool: openapi_query.`,
          },
        ],
      };
    }

    const parsedArgs = QueryArgsSchema.safeParse(rawArgs ?? {});
    if (!parsedArgs.success) {
      const issues = parsedArgs.error.issues
        .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
        .join('; ');
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text:
              `INVALID_ARGUMENTS: ${issues}.\n\n` +
              `Example: openapi_query({ code: "spec.paths['/users']?.get?.responses" })`,
          },
        ],
      };
    }

    const { code, spec_path, root, max_bytes } = parsedArgs.data;

    try {
      const { spec } = readSpec(root, spec_path);
      const queryResult = evaluateSandboxQuery(spec, code);
      const value: unknown = queryResult.text === undefined
        ? { result: null, note: 'Query evaluated to undefined. Use an expression or add a return statement.' }
        : JSON.parse(queryResult.text);
      const text = queryResult.text ?? JSON.stringify(value, null, 2);
      const result = enforceSerializedByteBudget(value, text, max_bytes);

      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: result.text }],
          structuredContent: { ...result.errorPayload },
        };
      }

      return {
        content: [{ type: 'text' as const, text: result.text }],
        ...(isRecord(result.data) ? { structuredContent: result.data } : {}),
      };
    } catch (err) {
      return buildActionableToolError(err);
    }
  });

  return server;
}
