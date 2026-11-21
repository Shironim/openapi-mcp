import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { clearSpecCache } from '../src/engine/index';
import { createOpenApiMcpServer } from '../src/mcp/server';

const tempDirs: string[] = [];
const PROJECT_ROOT = resolve(import.meta.dir, '..');

function createFixtureProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'openapi-mcp-contract-'));
  tempDirs.push(root);

  const write = (relPath: string, content: string) => {
    const full = join(root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  };

  write(
    'schemas/errors.yml',
    `
ProblemDetails:
  type: object
  required: [type, title, status]
  properties:
    type:
      type: string
    title:
      type: string
    status:
      type: integer
    detail:
      type: string
`
  );

  write(
    'openapi.yml',
    `
openapi: "3.1.0"
info:
  title: Checkout API
  version: "1.4.0"
paths:
  /orders:
    post:
      operationId: createOrder
      tags: [Checkout]
      summary: Create a new checkout order
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [sku, qty]
              properties:
                sku:
                  type: string
                qty:
                  type: integer
      responses:
        "201":
          description: Order created
          content:
            application/json:
              schema:
                type: object
                properties:
                  orderId:
                    type: string
        "400":
          description: Bad Request
          content:
            application/problem+json:
              schema:
                $ref: "./schemas/errors.yml#/ProblemDetails"
        "422":
          description: Validation failed
          content:
            application/problem+json:
              schema:
                $ref: "./schemas/errors.yml#/ProblemDetails"
        "500":
          description: Internal Server Error
          content:
            application/problem+json:
              schema:
                $ref: "./schemas/errors.yml#/ProblemDetails"
  /health:
    get:
      summary: Health check
      responses:
        "200":
          description: Healthy
`
  );

  return root;
}

async function connectClientServer(rootDir: string) {
  const server = createOpenApiMcpServer({ defaultRootDir: rootDir });
  const client = new Client({ name: 'contract-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    server,
    client,
    close: async () => {
      await Promise.allSettled([client.close(), server.close()]);
    },
  };
}

beforeEach(() => {
  clearSpecCache();
});

afterEach(() => {
  clearSpecCache();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function extractToolText(res: Awaited<ReturnType<Client['callTool']>>): string {
  if (!Array.isArray(res.content) || res.content.length === 0) {
    throw new Error('Expected non-empty content array in CallToolResult');
  }
  const first = res.content[0] as { text?: unknown };
  if (typeof first.text !== 'string') {
    throw new Error('Expected text content in first CallToolResult item');
  }
  return first.text;
}

describe('MCP Protocol Contract (InMemoryTransport)', () => {
  it('completes initialize handshake with workflow instructions and capabilities', async () => {
    const root = createFixtureProject();
    const { client, close } = await connectClientServer(root);

    try {
      const serverInfo = client.getServerVersion();
      expect(serverInfo?.name).toBe('openapi-mcp');

      const caps = client.getServerCapabilities();
      expect(caps?.tools).toBeDefined();
      expect(caps?.resources).toBeDefined();
      expect(caps?.prompts).toBeDefined();

      const instructions = client.getInstructions() ?? '';
      expect(instructions).toContain('openapi://endpoints/index');
      expect(instructions).toContain('openapi_query');
      expect(instructions).toContain('4xx');
      expect(instructions).toContain('5xx');
    } finally {
      await close();
    }
  });

  it('registers openapi_query with strict readOnly/non-destructive annotations and schema', async () => {
    const root = createFixtureProject();
    const { client, close } = await connectClientServer(root);

    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(1);

      const queryTool = tools[0]!;
      expect(queryTool.name).toBe('openapi_query');
      expect(queryTool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });

      const props = queryTool.inputSchema.properties as Record<string, unknown>;
      expect(Object.keys(props).sort()).toEqual(['code', 'max_bytes', 'root', 'spec_path']);
      expect(queryTool.inputSchema.required).toEqual(['code']);
    } finally {
      await close();
    }
  });

  it('lists and reads openapi://endpoints/index resource in application/json with all error codes', async () => {
    const root = createFixtureProject();
    const { client, close } = await connectClientServer(root);

    try {
      const { resources } = await client.listResources();
      expect(resources.map(resource => resource.uri)).toContain('openapi://specs/catalog');
      expect(resources[0]?.uri).toBe('openapi://endpoints/index');
      expect(resources[0]?.mimeType).toBe('application/json');

      const readRes = await client.readResource({ uri: 'openapi://endpoints/index' });
      expect(readRes.contents).toHaveLength(1);
      expect(readRes.contents[0]?.mimeType).toBe('application/json');

      const indexJson = JSON.parse((readRes.contents[0] as { text: string }).text);
      expect(indexJson.title).toBe('Checkout API');
      expect(indexJson.totalEndpoints).toBe(2);
      expect(indexJson.endpointsWithErrorContracts).toBe(1);
      expect(indexJson.endpointsMissingErrorContracts).toEqual(['GET /health']);
      expect(indexJson.lines).toEqual([
        'POST /orders — Create a new checkout order — [201, 400, 422, 500]',
        'GET /health — Health check — [200]',
      ]);
      expect(Buffer.byteLength((readRes.contents[0] as { text: string }).text, 'utf8')).toBeLessThan(
        4096
      );
    } finally {
      await close();
    }
  });

  it('discovers the search template, filters index entries and follows page links', async () => {
    const { client, close } = await connectClientServer(createFixtureProject());
    const search = 'openapi://endpoints/search';
    const read = async (uri: string) => {
      const result = await client.readResource({ uri });
      return JSON.parse((result.contents[0] as { text: string }).text);
    };
    try {
      expect((await client.listResourceTemplates()).resourceTemplates[0]?.uriTemplate).toContain(search);
      const first = await read(search + '?q=H&limit=1');
      expect(first.totalMatches).toBe(2);
      expect(first.endpoints[0].errorBodies['422'].schemaMediaTypes).toEqual(['application/problem+json']);
      const second = await read(first.nextUri);
      expect(second.endpoints.map((entry: { path: string }) => entry.path)).toEqual(['/health']);
      expect(second.nextUri).toBeNull();
      expect((await read(search + '?tag=checkout&operationId=CREATEORDER')).totalMatches).toBe(1);
      expect((await read(search + '?tag=checkout&q=missing')).totalMatches).toBe(0);
      await expect(read(search + '?limit=0')).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it('returns spec_not_found JSON safely when reading index in an empty workspace', async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'openapi-mcp-empty-'));
    tempDirs.push(emptyRoot);
    const { client, close } = await connectClientServer(emptyRoot);

    try {
      await expect(client.readResource({ uri: 'openapi://endpoints/search?limit=0' })).rejects.toThrow();
      const readRes = await client.readResource({ uri: 'openapi://endpoints/index' });
      const payload = JSON.parse((readRes.contents[0] as { text: string }).text);
      expect(payload.status).toBe('spec_not_found');
      expect(Array.isArray(payload.checkedCandidates)).toBe(true);
    } finally {
      await close();
    }
  });

  it('discovers and selects independent monorepo specs and recovers a missing local reference', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openapi-monorepo-'));
    tempDirs.push(root);
    const header = { $ref: './header.json' };
    for (const service of ['billing', 'sales']) {
      const dir = join(root, 'apps', service);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'openapi.yaml'), JSON.stringify({
        openapi: '3.1.0', info: { title: service, version: '1' },
        paths: { '/items': { get: { responses: { '200': { description: service,
          headers: { value: header, token: header },
          content: { 'application/json': { examples: { demo: { value: { $ref: 'literal' } } } } },
        } } } }, '/health': { get: {} } },
      }));
      if (service === 'sales') writeFileSync(join(dir, 'header.json'), '{"description":"sales"}');
    }
    const { client, close } = await connectClientServer(root);
    const read = async (uri: string) => {
      const content = (await client.readResource({ uri })).contents[0];
      if (!content || !('text' in content)) throw new Error('Expected a JSON resource');
      return JSON.parse(content.text);
    };
    const query = (service: string) => client.callTool({ name: 'openapi_query', arguments: {
      spec_path: `apps/${service}/openapi.yaml`, code: "spec.paths['/items'].get.responses['200']",
    } });
    try {
      expect((await read('openapi://specs/catalog')).specPaths).toEqual(['apps/billing/openapi.yaml', 'apps/sales/openapi.yaml']);
      const billing = '?spec_path=apps/billing/openapi.yaml';
      for (const resource of ['index', 'search']) {
        await expect(read('openapi://endpoints/' + resource + billing)).rejects.toThrow(/REF_FILE_NOT_FOUND.*header.json/);
      }
      expect((await query('billing')).isError).toBe(true);
      const sales = (await query('sales')).structuredContent as any;
      expect(sales.headers.value).toEqual({ description: 'sales' });
      expect(sales.headers.value).toEqual(sales.headers.token);
      expect(sales.content['application/json'].examples.demo.value).toEqual({ $ref: 'literal' });
      writeFileSync(join(root, 'apps/billing/header.json'), '{"description":"billing"}');
      expect((await read('openapi://endpoints/index' + billing)).title).toBe('billing');
      const page = await read('openapi://endpoints/search' + billing + '&limit=1');
      expect(new URL(page.nextUri).searchParams.get('spec_path')).toBe('apps/billing/openapi.yaml');
      expect((await read(page.nextUri)).endpoints[0].path).toBe('/health');
      expect((await read('openapi://endpoints/index')).status).toBe('spec_not_found');
    } finally {
      await close();
    }
  });

  it('lists and renders prompts and passes anti-prompt-drift verification against live schemas', async () => {
    const root = createFixtureProject();
    const { client, close } = await connectClientServer(root);

    try {
      const [{ tools }, { resources }, { prompts }] = await Promise.all([
        client.listTools(),
        client.listResources(),
        client.listPrompts(),
      ]);

      const toolNames = new Set(tools.map((t) => t.name));
      const toolParamNames = new Set(
        tools.flatMap((t) => Object.keys((t.inputSchema.properties ?? {}) as Record<string, unknown>))
      );
      const resourceUris = new Set(resources.map((r) => r.uri));

      expect(prompts.map((p) => p.name).sort()).toEqual([
        'audit-error-contracts',
        'sync-frontend-api',
      ]);

      for (const prompt of prompts) {
        for (const args of [undefined, { endpoint: 'POST /orders' }]) {
          const rendered = await client.getPrompt({
            name: prompt.name,
            ...(args ? { arguments: args } : {}),
          });
          expect(rendered.messages.length).toBeGreaterThan(0);

          const fullText = rendered.messages
            .map((m) => (m.content.type === 'text' ? m.content.text : ''))
            .join('\n');

          // Anti-prompt-drift: every referenced openapi_* tool name must exist in tools/list
          const referencedTools = fullText.match(/\bopenapi_[a-z_]+\b/g) ?? [];
          expect(referencedTools.length).toBeGreaterThan(0);
          for (const tName of referencedTools) {
            expect(toolNames.has(tName)).toBe(true);
          }

          // Anti-prompt-drift: every referenced resource URI must exist in resources/list
          const referencedUris = fullText.match(/openapi:\/\/[a-z0-9/_-]+/g) ?? [];
          expect(referencedUris.length).toBeGreaterThan(0);
          for (const uri of referencedUris) {
            expect(resourceUris.has(uri)).toBe(true);
          }

          // Anti-prompt-drift: every backticked parameter name called out for openapi_query must exist
          for (const param of ['code', 'spec_path', 'root', 'max_bytes']) {
            if (fullText.includes(`\`${param}\``)) {
              expect(toolParamNames.has(param)).toBe(true);
            }
          }

          if (args?.endpoint) {
            expect(fullText).toContain('/orders');
          }
        }
      }
    } finally {
      await close();
    }
  });

  it('executes openapi_query for object/array outputs and returns actionable errors on violations', async () => {
    const root = createFixtureProject();
    const { client, close } = await connectClientServer(root);

    try {
      // Query object output -> includes both text and structuredContent
      const err422 = await client.callTool({
        name: 'openapi_query',
        arguments: {
          code: "spec.paths['/orders'].post.responses['422']",
        },
      });
      expect(err422.isError).toBeFalsy();
      const parsed422 = JSON.parse(extractToolText(err422));
      expect(parsed422.content['application/problem+json'].schema.properties.status.type).toBe(
        'integer'
      );
      expect(err422.structuredContent).toBeDefined();

      // Query array output -> valid CallToolResult without schema error on structuredContent
      const keysRes = await client.callTool({
        name: 'openapi_query',
        arguments: {
          code: 'Object.keys(spec.paths)',
        },
      });
      expect(keysRes.isError).toBeFalsy();
      expect(JSON.parse(extractToolText(keysRes))).toEqual([
        '/orders',
        '/health',
      ]);

      // Sandbox rejection -> actionable isError: true
      const forbiddenRes = await client.callTool({
        name: 'openapi_query',
        arguments: { code: 'process.env' },
      });
      expect(forbiddenRes.isError).toBe(true);
      expect(extractToolText(forbiddenRes)).toContain('SANDBOX_FORBIDDEN_API');
      expect(extractToolText(forbiddenRes)).toContain('Next step:');

      // Path traversal rejection -> actionable isError: true
      const traversalRes = await client.callTool({
        name: 'openapi_query',
        arguments: { code: 'spec.info', spec_path: '../../etc/passwd' },
      });
      expect(traversalRes.isError).toBe(true);
      expect(extractToolText(traversalRes)).toContain('PATH_TRAVERSAL_DENIED');

      // Byte budget exceeded -> actionable isError: true
      const budgetRes = await client.callTool({
        name: 'openapi_query',
        arguments: { code: 'spec', max_bytes: 128 },
      });
      expect(budgetRes.isError).toBe(true);
      const budgetPayload = JSON.parse(extractToolText(budgetRes));
      expect(budgetPayload.error).toBe('RESPONSE_BUDGET_EXCEEDED');
      expect(budgetPayload.hint).toContain('max_bytes');
    } finally {
      await close();
    }
  });

  it('keeps index defaults stable across query overrides and enforces the configured workspace', async () => {
    const root = createFixtureProject();
    const otherRoot = createFixtureProject();
    writeFileSync(join(root, 'alternate.json'), JSON.stringify({
      openapi: '3.1.0', info: { title: 'Alternate' }, paths: {},
    }));
    const { client, close } = await connectClientServer(root);

    try {
      const indexBefore = await client.readResource({ uri: 'openapi://endpoints/index' });
      const alternate = await client.callTool({
        name: 'openapi_query',
        arguments: { spec_path: 'alternate.json', code: 'spec.info.title' },
      });
      expect(JSON.parse(extractToolText(alternate))).toBe('Alternate');
      const outside = await client.callTool({
        name: 'openapi_query',
        arguments: { root: otherRoot, code: 'spec.info.title' },
      });
      expect(outside.isError).toBe(true);
      expect(extractToolText(outside)).toContain('PATH_TRAVERSAL_DENIED');

      const indexAfter = await client.readResource({ uri: 'openapi://endpoints/index' });
      expect(indexAfter).toEqual(indexBefore);
      const fallback = await client.callTool({
        name: 'openapi_query', arguments: { code: 'Object.keys(spec.paths)' },
      });
      expect(JSON.parse(extractToolText(fallback))).toEqual(['/orders', '/health']);
    } finally {
      await close();
    }
  });
});

describe('CLI & Stdio Transport Lifecycle', () => {
  it('writes --version and --help to stderr only (zero stdout pollution)', async () => {
    for (const flag of ['--version', '--help']) {
      const proc = Bun.spawn([process.execPath, 'run', 'src/index.ts', flag], {
        cwd: PROJECT_ROOT,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdoutText, stderrText] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stdoutText).toBe('');
      expect(stderrText.length).toBeGreaterThan(0);
    }
  });

  it('auto-starts stdio on piped stdin, answers JSON-RPC initialize on stdout, and shuts down cleanly on stdin close', async () => {
    const proc = Bun.spawn([process.execPath, 'run', 'src/index.ts'], {
      cwd: PROJECT_ROOT,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const initRequest =
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'stdio-smoke', version: '1.0.0' },
        },
      }) + '\n';

    proc.stdin.write(initRequest);
    await proc.stdin.flush();

    // Read first line from stdout to confirm pure JSON-RPC response before closing stdin
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let stdoutBuffer = '';
    while (!stdoutBuffer.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      stdoutBuffer += decoder.decode(value, { stream: true });
    }
    reader.releaseLock();

    const firstLine = stdoutBuffer.trim().split('\n')[0]!;
    const rpcResponse = JSON.parse(firstLine);
    expect(rpcResponse.jsonrpc).toBe('2.0');
    expect(rpcResponse.id).toBe(1);
    expect(rpcResponse.result.serverInfo.name).toBe('openapi-mcp');

    // Close stdin and verify graceful shutdown with exit code 0
    await proc.stdin.end();
    const [exitCode, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderrText).toContain('[openapi-mcp]');
  });
});
