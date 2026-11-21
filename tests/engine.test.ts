import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_MAX_BYTES,
  buildEndpointIndex,
  clearSpecCache,
  enforceByteBudget,
  loadOpenApiSpec,
  runSandboxQuery,
} from '../src/engine/index';

const tempDirs: string[] = [];

function createWorkspace(): {
  root: string;
  write: (relPath: string, content: string) => string;
} {
  const root = mkdtempSync(join(tmpdir(), 'openapi-mcp-engine-'));
  tempDirs.push(root);
  const write = (relPath: string, content: string) => {
    const full = join(root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
    return full;
  };
  return { root, write };
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

describe('Core Engine — OpenAPI Spec Loader & Security Guards', () => {
  it('resolves circular $ref (self, mutual, and cross-file) with markers while preserving DAG reuse', () => {
    const { root, write } = createWorkspace();
    write(
      'schemas/cyclic.yml',
      `
CyclicA:
  type: object
  properties:
    back:
      $ref: '../openapi.yml#/components/schemas/HostCyclic'
`
    );
    write(
      'openapi.yml',
      `
openapi: "3.1.0"
info:
  title: Circular API
  version: "1.0.0"
paths:
  /tree:
    get:
      summary: Get tree
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/TreeNode"
components:
  schemas:
    Address:
      type: object
      properties:
        city:
          type: string
    Customer:
      type: object
      properties:
        billingAddress:
          $ref: "#/components/schemas/Address"
        shippingAddress:
          $ref: "#/components/schemas/Address"
    TreeNode:
      type: object
      properties:
        id:
          type: string
        children:
          type: array
          items:
            $ref: "#/components/schemas/TreeNode"
    ErrorEnvelope:
      type: object
      properties:
        code:
          type: string
        cause:
          $ref: "#/components/schemas/ErrorDetail"
    ErrorDetail:
      type: object
      properties:
        message:
          type: string
        nested:
          $ref: "#/components/schemas/ErrorEnvelope"
    HostCyclic:
      type: object
      properties:
        next:
          $ref: "./schemas/cyclic.yml#/CyclicA"
`
    );

    const loaded = loadOpenApiSpec({ rootDir: root });
    const spec = loaded.spec as any;

    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.paths['/tree'].get)).toBe(true);

    // Self-circular ref replaced cleanly
    const treeSchema = spec.paths['/tree'].get.responses['200'].content['application/json'].schema;
    expect(treeSchema.properties.id.type).toBe('string');
    expect(treeSchema.properties.children.items).toBe('[Circular: #/components/schemas/TreeNode]');

    // Direct schema node in components also guarded
    expect(spec.components.schemas.TreeNode.properties.children.items).toBe(
      '[Circular: #/components/schemas/TreeNode]'
    );

    // Mutual circular ref guarded
    expect(spec.components.schemas.ErrorEnvelope.properties.cause.properties.nested).toBe(
      '[Circular: #/components/schemas/ErrorEnvelope]'
    );

    // Cross-file circular ref guarded
    expect(spec.components.schemas.HostCyclic.properties.next.properties.back).toBe(
      '[Circular: ../openapi.yml#/components/schemas/HostCyclic]'
    );

    // Diamond DAG reuse works completely without false circular marker
    expect(spec.components.schemas.Customer.properties.billingAddress.properties.city.type).toBe('string');
    expect(spec.components.schemas.Customer.properties.shippingAddress.properties.city.type).toBe('string');
  });

  it('resolves multi-file relative $ref and rejects path traversal, remote refs, and escaping symlinks', () => {
    const { root, write } = createWorkspace();
    const outsideDir = mkdtempSync(join(tmpdir(), 'openapi-mcp-outside-'));
    tempDirs.push(outsideDir);
    const outsideSecret = join(outsideDir, 'secret.yml');
    writeFileSync(outsideSecret, 'Secret:\n  type: string\n', 'utf8');

    write(
      'schemas/common.yml',
      `
TraceMeta:
  type: object
  properties:
    requestId:
      type: string
`
    );
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
    meta:
      $ref: "./common.yml#/TraceMeta"
`
    );
    write(
      'openapi.yml',
      `
openapi: "3.0.3"
info:
  title: Orders API
  version: "1.0.0"
paths:
  /orders:
    post:
      summary: Create order
      responses:
        "201":
          description: Created
        "422":
          description: Validation error
          content:
            application/problem+json:
              schema:
                $ref: "./schemas/errors.yml#/ProblemDetails"
                description: Overridden validation problem
`
    );

    const loaded = loadOpenApiSpec({ rootDir: root });
    const schema422 = (loaded.spec as any).paths['/orders'].post.responses['422'].content[
      'application/problem+json'
    ].schema;
    expect(schema422.properties.status.type).toBe('integer');
    expect(schema422.properties.meta.properties.requestId.type).toBe('string');
    expect(schema422.description).toBe('Overridden validation problem');

    // Reject path traversal in explicit specPath
    expect(() =>
      loadOpenApiSpec({ rootDir: root, specPath: `../${outsideDir.split('/').pop()}/secret.yml` })
    ).toThrow(/PATH_TRAVERSAL_DENIED/);

    // Reject path traversal inside $ref
    write(
      'traversal.yml',
      `
openapi: "3.0.3"
info:
  title: Traversal
  version: "1.0.0"
paths: {}
components:
  schemas:
    Leak:
      $ref: "../../etc/passwd"
`
    );
    expect(() => loadOpenApiSpec({ rootDir: root, specPath: 'traversal.yml' })).toThrow(
      /PATH_TRAVERSAL_DENIED/
    );

    // Reject remote $ref
    write(
      'remote.yml',
      `
openapi: "3.0.3"
info:
  title: Remote
  version: "1.0.0"
paths: {}
components:
  schemas:
    Remote:
      $ref: "https://example.com/schema.json"
`
    );
    expect(() => loadOpenApiSpec({ rootDir: root, specPath: 'remote.yml' })).toThrow(
      /REMOTE_REF_DENIED/
    );

    // Reject symlink escaping workspace root (both direct specPath and via $ref)
    const symlinkTarget = join(root, 'escape-link.yml');
    symlinkSync(outsideSecret, symlinkTarget);
    expect(() => loadOpenApiSpec({ rootDir: root, specPath: 'escape-link.yml' })).toThrow(
      /PATH_TRAVERSAL_DENIED/
    );

    write(
      'symlink-ref.yml',
      `
openapi: "3.0.3"
info:
  title: Symlink Ref
  version: "1.0.0"
paths: {}
components:
  schemas:
    Leak:
      $ref: "./escape-link.yml#/Secret"
`
    );
    expect(() => loadOpenApiSpec({ rootDir: root, specPath: 'symlink-ref.yml' })).toThrow(
      /PATH_TRAVERSAL_DENIED/
    );
  });

  it('automatically invalidates freshness cache when root spec or referenced files change', () => {
    const { root, write } = createWorkspace();
    write(
      'schemas/errors.yml',
      `
ApiError:
  type: object
  properties:
    code:
      type: string
`
    );
    write(
      'openapi.json',
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Cache Test', version: '1.0.0' },
        paths: {
          '/ping': {
            get: {
              summary: 'Ping',
              responses: {
                '200': { description: 'Pong' },
                '500': {
                  description: 'Internal error',
                  content: {
                    'application/json': {
                      schema: { $ref: './schemas/errors.yml#/ApiError' },
                    },
                  },
                },
              },
            },
          },
        },
      })
    );

    const first = loadOpenApiSpec({ rootDir: root });
    expect(first.fromCache).toBe(false);
    expect((first.spec as any).info.version).toBe('1.0.0');

    const second = loadOpenApiSpec({ rootDir: root });
    expect(second.fromCache).toBe(true);
    expect(second.spec).toBe(first.spec);

    // Edit referenced external file -> cache must invalidate
    write(
      'schemas/errors.yml',
      `
ApiError:
  type: object
  properties:
    code:
      type: string
    retryable:
      type: boolean
`
    );
    const third = loadOpenApiSpec({ rootDir: root });
    expect(third.fromCache).toBe(false);
    expect(third.cacheKey).not.toBe(first.cacheKey);
    const errSchema = (third.spec as any).paths['/ping'].get.responses['500'].content['application/json']
      .schema;
    expect(errSchema.properties.retryable.type).toBe('boolean');

    // Edit root spec -> cache must invalidate
    write(
      'openapi.json',
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Cache Test', version: '2.0.0' },
        paths: {
          '/ping': {
            get: {
              summary: 'Ping v2',
              responses: {
                '200': { description: 'Pong' },
              },
            },
          },
        },
      })
    );
    const fourth = loadOpenApiSpec({ rootDir: root });
    expect(fourth.fromCache).toBe(false);
    expect((fourth.spec as any).info.version).toBe('2.0.0');
  });

  it('keeps OpenAPI 3.1 assertions, resolves empty pointer keys, and preserves literal examples', () => {
    const { root, write } = createWorkspace();
    write('values.json', JSON.stringify({ '': { type: 'string', minLength: 5 } }));
    const literal = { $ref: 'application-data' };
    write('openapi.json', JSON.stringify({
      openapi: '3.1.0',
      components: { schemas: {
        Name: { $ref: './values.json#/', minLength: 1, description: 'Name', examples: [literal] },
      } },
    }));
    const { spec } = loadOpenApiSpec({ rootDir: root });
    expect(runSandboxQuery(spec, 'spec.components.schemas.Name').value).toEqual({
      examples: [literal],
      description: 'Name',
      minLength: 1,
      allOf: [{ type: 'string', minLength: 5 }],
    });
  });

  it('refreshes the cache when a reference symlink is retargeted within the workspace', () => {
    const { root, write } = createWorkspace();
    write('openapi.json', JSON.stringify({ openapi: '3.1.0', components: {
      schemas: { Example: { $ref: './current.json' } },
    } }));
    write('first.json', '{"type":"string"}');
    write('second.json', '{"type":"integer"}');
    const link = join(root, 'current.json');
    symlinkSync('first.json', link, 'file');
    const before = loadOpenApiSpec({ rootDir: root });
    unlinkSync(link);
    symlinkSync('second.json', link, 'file');
    const after = loadOpenApiSpec({ rootDir: root });
    expect(after.fromCache).toBe(false);
    expect(after.cacheKey).not.toBe(before.cacheKey);
    expect(runSandboxQuery(after.spec, 'spec.components.schemas.Example.type').value).toBe('integer');
  });
});

describe('Core Engine — Index Builder, Read-Only Sandbox & Byte Budget', () => {
  it('builds compact endpoint index listing all 2xx/4xx/5xx codes and missing error contract warnings', () => {
    const index = buildEndpointIndex({
      openapi: '3.1.0',
      info: { title: 'Billing API', version: '1.2.0' },
      paths: {
        '/invoices': {
          get: {
            summary: 'List invoices',
            responses: {
              '500': { description: 'Server error' },
              '200': { description: 'OK' },
              '401': { description: 'Unauthorized' },
              '400': { description: 'Bad request' },
            },
          },
          post: {
            operationId: 'createInvoice',
            responses: {
              '201': { description: 'Created' },
              default: { description: 'Fallback' },
            },
          },
        },
      },
    });

    expect(index.totalEndpoints).toBe(2);
    expect(index.endpoints[0]?.errorBodies['401']).toEqual({ schemaMediaTypes: [] });
    expect(index.endpointsWithErrorContracts).toBe(1);
    expect(index.endpointsMissingErrorContracts).toEqual(['POST /invoices']);
    expect(index.lines[0]).toBe('GET /invoices — List invoices — [200, 400, 401, 500]');
    expect(index.lines[1]).toBe('POST /invoices — createInvoice — [201, default]');
    expect(index.endpoints[1]?.errorStatusCodes).toEqual([]);
    expect(index.endpoints[1]?.operationId).toBe('createInvoice');
  });

  it('executes valid read-only queries while blocking ambient globals, escapes, mutations, and infinite loops', () => {
    const spec = Object.freeze({
      openapi: '3.1.0',
      info: Object.freeze({ title: 'Safe API', version: '1.0.0' }),
      paths: Object.freeze({
        '/jobs': Object.freeze({
          post: Object.freeze({
            responses: Object.freeze({
              '202': Object.freeze({ description: 'Accepted' }),
              '422': Object.freeze({ description: 'Unprocessable' }),
            }),
          }),
        }),
      }),
      components: Object.freeze({
        schemas: Object.freeze({
          Job: Object.freeze({
            properties: Object.freeze({
              process: Object.freeze({ type: 'string' }),
              import: Object.freeze({ type: 'boolean' }),
            }),
          }),
        }),
      }),
    });

    // Expression query
    const res1 = runSandboxQuery(spec, "Object.keys(spec.paths['/jobs'].post.responses)");
    expect(res1.value).toEqual(['202', '422']);

    // Arrow function query
    const res2 = runSandboxQuery(spec, '(s) => s.info.title');
    expect(res2.value).toBe('Safe API');

    // Multi-statement query
    const res3 = runSandboxQuery(
      spec,
      'const codes = Object.keys(spec.paths["/jobs"].post.responses); return codes.filter(c => c.startsWith("4"));'
    );
    expect(res3.value).toEqual(['422']);

    // Legitimate OpenAPI schema property names & regex filters matching blocked bare globals (.process / .import)
    const res4 = runSandboxQuery(spec, 'spec.components.schemas.Job.properties');
    expect(res4.value).toEqual({
      process: { type: 'string' },
      import: { type: 'boolean' },
    });
    const res5 = runSandboxQuery(
      spec,
      "Object.keys(spec.paths).filter(p => !/\\/import/.test(p))"
    );
    expect(res5.value).toEqual(['/jobs']);

    // Reject dangerous globals & escape primitives
    for (const badCode of [
      'process.env',
      'Bun.env',
      'require("node:fs")',
      'fetch("https://example.com")',
      'import("node:fs")',
      'import("node:fs"); 123',
      'eval("1+1")',
      'Function("return 1")()',
      'spec.constructor.constructor("return process")()',
      'globalThis.process',
      'spec.__proto__',
    ]) {
      expect(() => runSandboxQuery(spec, badCode)).toThrow(/SANDBOX_FORBIDDEN_API/);
    }

    // Reject async/Promise results
    expect(() => runSandboxQuery(spec, 'Promise.resolve(123)')).toThrow(/SANDBOX_ASYNC_FORBIDDEN/);

    // Mutation fails and never mutates original spec
    expect(() => runSandboxQuery(spec, 'spec.info.title = "hacked"; return spec.info.title;')).toThrow(
      /SANDBOX_RUNTIME_ERROR/
    );
    expect(spec.info.title).toBe('Safe API');

    // Infinite loop strictly terminated within timeout
    const t0 = performance.now();
    expect(() => runSandboxQuery(spec, 'while (true) {}', { timeoutMs: 120 })).toThrow(
      /SANDBOX_TIMEOUT/
    );
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1500);
    expect(runSandboxQuery(spec, 'spec.info.title').value).toBe('Safe API');
  });

  it('enforces response byte budget with actionable narrowing hints when output is too large', () => {
    const small = enforceByteBudget({ status: 'ok', codes: [200, 400] });
    expect(small.ok).toBe(true);
    expect(small.truncated).toBe(false);
    expect(small.maxBytes).toBe(DEFAULT_MAX_BYTES);

    const bigSpec = {
      paths: Object.fromEntries(
        Array.from({ length: 120 }, (_, i) => [
          `/resource-${i}`,
          {
            get: {
              summary: `Endpoint ${i} with verbose payload description `.repeat(4),
              responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
            },
          },
        ])
      ),
      components: { schemas: { ProblemDetails: { type: 'object' } } },
    };

    const bigResult = enforceByteBudget(bigSpec);
    expect(bigResult.ok).toBe(false);
    if (!bigResult.ok) {
      expect(bigResult.truncated).toBe(true);
      expect(bigResult.byteLength).toBeGreaterThan(DEFAULT_MAX_BYTES);
      expect(bigResult.errorPayload.error).toBe('RESPONSE_BUDGET_EXCEEDED');
      expect(bigResult.errorPayload.summary.availableKeys).toEqual(['paths', 'components']);
      expect(bigResult.errorPayload.hint).toContain('Narrow your openapi_query');
      expect(bigResult.errorPayload.examples.length).toBeGreaterThan(0);
    }
  });

  it('bounds guest result transfer and reads caller-owned documents fresh', () => {
    const spec = { info: { title: 'First' } };
    expect(runSandboxQuery(spec, 'spec.info.title').value).toBe('First');
    spec.info.title = 'Second';
    expect(runSandboxQuery(spec, 'spec.info.title').value).toBe('Second');
    expect(() => runSandboxQuery(spec, '"a".repeat(1100000)', { timeoutMs: 1000 })).toThrow(/SANDBOX_LIMIT/);
  });
});
