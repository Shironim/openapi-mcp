import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import packageInfo from '../../package.json' with { type: 'json' };
import { MAX_RESULT_BYTES, enforceSerializedByteBudget } from '../engine/budget.js';
import {
  DEFAULT_MAX_BYTES,
  diffOpenApiSpecs,
  loadOpenApiSpec,
  type SandboxMetadata,
} from '../engine/index.js';
import { isRecord } from '../engine/json.js';
import { MAX_QUERY_CODE_LENGTH, evaluateSandboxQuery } from '../engine/query-sandbox.js';
import { MissingReferenceError } from '../engine/spec-loader.js';
import { OPENAPI_PROMPTS, getOpenApiPrompt } from './prompts.js';
import { OPENAPI_RESOURCES, registerResourceHandlers } from './resources.js';

export { OPENAPI_PROMPTS, OPENAPI_RESOURCES, getOpenApiPrompt };
export const OPENAPI_MCP_VERSION: string = packageInfo.version;

const QUERY_NAME = 'openapi_query';
const DIFF_NAME = 'openapi_diff';

export const OPENAPI_MCP_INSTRUCTIONS = [
  'Use openapi-mcp in local Code Mode (index-first, query-on-demand):',
  'For monorepos read openapi://specs/catalog, then use the selected spec_path for index, search, schemas, diagnostics, and query.',
  'Discover endpoints with openapi://endpoints/index or openapi://endpoints/search?q=orders&limit=20 (supports tag, method, pathPrefix, operationId, missingErrorContracts) and follow nextUri. Error status counts indicate declarations only; check errorBodies and query the response for field details.',
  'Inspect reusable models and reverse endpoint usage with openapi://schemas/index or openapi://schemas/search?q=Order. Run multi-issue contract health checks with openapi://spec/diagnostics.',
  '1. Read `openapi://endpoints/index` (or `openapi://endpoints/search`) for endpoints, 2xx/4xx/5xx status codes, auth schemes, and YAML/JSON `sourceLocation`.',
  '2. Use `openapi_query` with targeted JavaScript against `spec` and read-only `helpers` (`helpers.op(method, path)` merges path+op parameters, auth, 2xx & 4xx/5xx responses; `helpers.example(method, path, status?)` or `helpers.example(schema)` synthesizes deterministic JSON fixtures; `helpers.schemaRefs(name)` lists reverse references).',
  '3. Use `openapi_diff` to compare two local specs (`base_spec_path` vs `target_spec_path`) and detect breaking vs non-breaking contract changes.',
  `4. Keep queries scoped to specific paths or schemas. The default \`max_bytes\` is ${DEFAULT_MAX_BYTES} UTF-8 bytes of result text.`,
].join('\n');

const QueryArgsSchema = z.strictObject({
  code: z.string().regex(/\S/).max(MAX_QUERY_CODE_LENGTH).describe(
    "JavaScript expression or function body evaluated against `spec` and read-only `helpers` (op, example, schemaRefs), e.g. helpers.op('POST', '/orders') or spec.paths['/users']?.get?.responses."
  ),
  spec_path: z.string().regex(/\S/).optional().describe('Optional path to the OpenAPI spec inside the selected workspace.'),
  root: z.string().regex(/\S/).optional().describe('Workspace for this query. When a server root is configured, this path must remain within it.'),
  max_bytes: z.number().int().min(1).max(MAX_RESULT_BYTES).optional().describe(
    `UTF-8 budget for successful query JSON (default: ${DEFAULT_MAX_BYTES}).`
  ),
});

const DiffArgsSchema = z.strictObject({
  base_spec_path: z.string().regex(/\S/).describe('Path to the baseline OpenAPI spec inside the workspace.'),
  target_spec_path: z.string().regex(/\S/).describe('Path to the target/updated OpenAPI spec inside the workspace.'),
  root: z.string().regex(/\S/).optional().describe('Workspace for both specs. When a server root is configured, this path must remain within it.'),
  max_bytes: z.number().int().min(1).max(MAX_RESULT_BYTES).optional().describe(
    `UTF-8 budget for diff JSON (default: ${DEFAULT_MAX_BYTES}).`
  ),
});

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const OPENAPI_TOOLS = [
  {
    name: QUERY_NAME,
    description:
      'Query the resolved, read-only OpenAPI spec using synchronous JavaScript against `spec` and built-in `helpers` (`helpers.op`, `helpers.example`, `helpers.schemaRefs`).',
    inputSchema: z.toJSONSchema(QueryArgsSchema),
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: DIFF_NAME,
    description:
      'Compare two local OpenAPI specs (`base_spec_path` vs `target_spec_path`) and classify semantic contract changes into breaking vs non-breaking.',
    inputSchema: z.toJSONSchema(DiffArgsSchema),
    annotations: READ_ONLY_ANNOTATIONS,
  },
] as const;

export interface OpenApiMcpServerOptions {
  defaultRootDir?: string;
  defaultSpecPath?: string;
}

function formatInvalidArgsError(error: z.ZodError, example: string) {
  const issues = error.issues
    .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
    .join('; ');
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: `INVALID_ARGUMENTS: ${issues}.\n\nExample: ${example}` }],
  };
}

function formatBudgetedToolResult(value: unknown, text: string, maxBytes?: number) {
  const result = enforceSerializedByteBudget(value, text, maxBytes);
  if (!result.ok) {
    return {
      isError: true as const,
      content: [{ type: 'text' as const, text: result.text }],
      structuredContent: { ...result.errorPayload },
    };
  }
  return {
    content: [{ type: 'text' as const, text: result.text }],
    ...(isRecord(result.data) ? { structuredContent: result.data } : {}),
  };
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
    content: [{ type: 'text', text: `${rawMessage}\n\nNext step: ${recoveryHint}` }],
  };
}

export function createOpenApiMcpServer(options: OpenApiMcpServerOptions = {}): Server {
  const configuredRoot = options.defaultRootDir?.trim() || undefined;
  const defaultRoot = configuredRoot ?? process.cwd();
  const defaultSpec = options.defaultSpecPath?.trim() || undefined;
  const sandboxMetaCache = new WeakMap<object, SandboxMetadata>();

  function readSpec(root?: string, specPath?: string) {
    return loadOpenApiSpec({
      rootDir: root ?? defaultRoot,
      specPath: specPath ?? (root ? undefined : defaultSpec),
      allowedRootDir: configuredRoot,
    });
  }

  const server = new Server(
    { name: 'openapi-mcp', version: OPENAPI_MCP_VERSION },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: OPENAPI_MCP_INSTRUCTIONS,
    }
  );

  registerResourceHandlers(server, { defaultRoot, configuredRoot, defaultSpec, readSpec });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: OPENAPI_PROMPTS.map((p) => ({
      name: p.name,
      title: p.title,
      description: p.description,
      arguments: p.arguments.map((a) => ({ ...a })),
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    getOpenApiPrompt(request.params.name, request.params.arguments)
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: OPENAPI_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { ...t.annotations },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;

    if (name === DIFF_NAME) {
      const parsed = DiffArgsSchema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        return formatInvalidArgsError(
          parsed.error,
          'openapi_diff({ base_spec_path: "openapi.yml", target_spec_path: "docs/openapi.yml" })'
        );
      }
      const { base_spec_path, target_spec_path, root, max_bytes } = parsed.data;
      try {
        const baseLoaded = readSpec(root, base_spec_path);
        const targetLoaded = readSpec(root, target_spec_path);
        const report = diffOpenApiSpecs(baseLoaded.spec, targetLoaded.spec, {
          base: base_spec_path,
          target: target_spec_path,
        });
        return formatBudgetedToolResult(report, JSON.stringify(report, null, 2), max_bytes);
      } catch (err) {
        return buildActionableToolError(err);
      }
    }

    if (name !== QUERY_NAME) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Unknown tool '${name}'. Available tools: ${QUERY_NAME}, ${DIFF_NAME}.` }],
      };
    }

    const parsed = QueryArgsSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return formatInvalidArgsError(parsed.error, `openapi_query({ code: "spec.paths['/users']?.get?.responses" })`);
    }

    const { code, spec_path, root, max_bytes } = parsed.data;
    try {
      const loaded = readSpec(root, spec_path);
      let metadata = sandboxMetaCache.get(loaded.spec);
      if (!metadata) {
        metadata = { sourceLocations: loaded.sourceLocations, schemaUsages: loaded.schemaUsages };
        sandboxMetaCache.set(loaded.spec, metadata);
      }
      const queryResult = evaluateSandboxQuery(loaded.spec, code, { metadata });
      const value: unknown = queryResult.text === undefined
        ? { result: null, note: 'Query evaluated to undefined. Use an expression or add a return statement.' }
        : JSON.parse(queryResult.text);
      const text = queryResult.text ?? JSON.stringify(value, null, 2);
      return formatBudgetedToolResult(value, text, max_bytes);
    } catch (err) {
      return buildActionableToolError(err);
    }
  });

  return server;
}
