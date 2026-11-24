import { HTTP_METHODS } from '../engine/index.js';

const METHOD_PREFIX = new RegExp(`^(?:${HTTP_METHODS.join('|')})\\s+`, 'i');
const METHOD_AND_PATH = new RegExp(`^(${HTTP_METHODS.join('|')})\\s+(.+)$`, 'i');

export const OPENAPI_PROMPTS = [
  {
    name: 'sync-frontend-api',
    title: 'Sync Frontend API Contract',
    description:
      'Guide frontend-backend contract sync: read endpoint/schema indexes, query merged operation + 2xx + 4xx/5xx error schemas with openapi_query, and update frontend callers.',
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
      'Audit completeness and schema consistency of 4xx/5xx error responses across OpenAPI endpoints using spec diagnostics and openapi_query.',
    arguments: [
      {
        name: 'endpoint',
        description: "Optional endpoint filter or path (e.g. 'POST /orders' or '/users') to scope the audit.",
        required: false,
      },
    ],
  },
  {
    name: 'review-breaking-changes',
    title: 'Review OpenAPI Breaking Changes',
    description:
      'Compare two local OpenAPI specs with openapi_diff, inspect impacted schemas/endpoints, and summarize breaking vs non-breaking contract changes.',
    arguments: [
      {
        name: 'base_spec_path',
        description: "Optional baseline spec path relative to workspace root (e.g. 'openapi.yml').",
        required: false,
      },
      {
        name: 'target_spec_path',
        description: "Optional target spec path relative to workspace root (e.g. 'docs/openapi.yml').",
        required: false,
      },
    ],
  },
  {
    name: 'generate-test-fixtures',
    title: 'Generate Deterministic API Test Fixtures',
    description:
      'Synthesize deterministic request, 2xx success, and 4xx/5xx error JSON fixtures from resolved OpenAPI schemas using helpers.example.',
    arguments: [
      {
        name: 'endpoint',
        description: "Optional endpoint filter or path (e.g. 'POST /orders' or '/users').",
        required: false,
      },
    ],
  },
] as const;

export function getOpenApiPrompt(
  name: string,
  args: Record<string, string | undefined> = {}
) {
  const endpoint = args.endpoint?.trim();
  const methodMatch = endpoint?.match(METHOD_AND_PATH);
  const parsedMethod = methodMatch?.[1]?.toUpperCase();
  const parsedPath = methodMatch?.[2]?.trim() ?? endpoint?.replace(METHOD_PREFIX, '');
  const pathLookup = parsedPath ? `spec.paths[${JSON.stringify(parsedPath)}]` : undefined;
  const helperOpLookup = parsedMethod && parsedPath
    ? `helpers.op(${JSON.stringify(parsedMethod)}, ${JSON.stringify(parsedPath)})`
    : undefined;
  const helperExampleLookup = parsedMethod && parsedPath
    ? `helpers.example(${JSON.stringify(parsedMethod)}, ${JSON.stringify(parsedPath)})`
    : undefined;

  switch (name) {
    case 'sync-frontend-api': {
      const targetLabel = endpoint ? `for '${endpoint}'` : 'for the target endpoint';
      const querySnippet = helperOpLookup ?? pathLookup ?? "helpers.op('POST', '/your-endpoint')";

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
                '1. Read resource `openapi://endpoints/index` (and `openapi://schemas/index` if shared models are involved) to verify exact path, HTTP method, auth `security`, `sourceLocation`, and all declared status codes (`2xx`, `4xx`, `5xx`).',
                `2. Call \`openapi_query\` with \`code\` (and optional \`spec_path\` / \`root\` / \`max_bytes\`) using \`${querySnippet}\` to inspect merged path+operation \`parameters\`, \`requestBody\`, \`2xx\` responses, AND every \`4xx\`/\`5xx\` error schema.`,
                '3. Compare request payloads, auth headers, success DTOs, and error handling branches (status codes, error codes, ProblemDetails/validation fields) in the frontend codebase against the queried OpenAPI contract and align any mismatches.',
              ].join('\n'),
            },
          },
        ],
      };
    }

    case 'audit-error-contracts': {
      const scopeLabel = endpoint ? `for endpoint '${endpoint}'` : 'across all endpoints';
      const queryExample = helperOpLookup ?? pathLookup ??
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
                '1. Read `openapi://spec/diagnostics` and `openapi://endpoints/index` to inspect `MISSING_ERROR_CONTRACT`, `ERROR_RESPONSE_MISSING_SCHEMA`, `endpointsMissingErrorContracts`, and each endpoint\'s `errorStatusCodes` / `errorBodies`.',
                `2. Call \`openapi_query\` with \`code\` (and optional \`spec_path\` / \`root\` / \`max_bytes\`) to inspect error response schemas (e.g. \`${queryExample}\`) and verify consistent error structures (such as ProblemDetails / validation error fields) for 400, 401, 403, 404, 422, and 500 responses.`,
                '3. Summarize gaps, missing status codes, and schema inconsistencies with exact `sourceLocation` and concrete remediation steps.',
              ].join('\n'),
            },
          },
        ],
      };
    }

    case 'review-breaking-changes': {
      const basePath = args.base_spec_path?.trim() || 'openapi.yml';
      const targetPath = args.target_spec_path?.trim() || 'docs/openapi.yml';

      return {
        description:
          'Compare two local OpenAPI specs and assess breaking vs non-breaking contract changes.',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                `Review contract changes between '${basePath}' and '${targetPath}':`,
                '1. If you are unsure of the spec paths in this workspace, read `openapi://specs/catalog` first.',
                `2. Call \`openapi_diff\` with \`base_spec_path\`: ${JSON.stringify(basePath)} and \`target_spec_path\`: ${JSON.stringify(targetPath)} (plus optional \`root\` / \`max_bytes\`) to classify \`breaking\` vs \`nonBreaking\` changes.`,
                '3. For each breaking change, read `openapi://schemas/index` or call `openapi_query` with `helpers.op(method, path)` / `helpers.schemaRefs(name)` to assess caller blast radius and propose backward-compatible migrations.',
              ].join('\n'),
            },
          },
        ],
      };
    }

    case 'generate-test-fixtures': {
      const targetLabel = endpoint ? `for '${endpoint}'` : 'for the target endpoint';
      const exampleSnippet = helperExampleLookup ?? "helpers.example('POST', '/your-endpoint')";
      const opSnippet = helperOpLookup ?? pathLookup ?? "helpers.op('POST', '/your-endpoint')";

      return {
        description:
          'Generate deterministic request and response JSON test fixtures from resolved OpenAPI schemas.',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                `Generate deterministic API test fixtures ${targetLabel}:`,
                '1. Read `openapi://endpoints/index` to verify exact method, path, auth requirements, and declared `2xx` / `4xx` / `5xx` status codes.',
                `2. Call \`openapi_query\` with \`code\`: \`${exampleSnippet}\` (and \`${opSnippet}\` for required parameters/headers) to synthesize deterministic JSON payloads for request bodies, success responses, and error responses.`,
                '3. Convert the generated payloads into unit, integration, or E2E test fixtures covering both happy-path `2xx` responses and `4xx`/`5xx` error branches.',
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
