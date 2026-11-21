import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import packageInfo from '../package.json' with { type: 'json' };

const { version } = packageInfo;
const [command, ...args] = process.argv.slice(2);
assert.ok(command, 'Pass an executable followed by any arguments.');
const root = mkdtempSync(join(tmpdir(), 'openapi-release-smoke-'));
const uri = 'openapi://endpoints/index';
const spec = {
  openapi: '3.1.0',
  info: { title: 'Release smoke', version: '1.0.0' },
  paths: { '/items': { get: { responses: {
    200: { description: 'OK' }, 422: { description: 'Invalid' },
  } } } },
};

const client = new Client({ name: 'release-smoke', version });
const transport = new StdioClientTransport({
  command,
  args: [...args, 'serve', '--root', root],
  stderr: 'pipe',
});
const timeout = { timeout: 10_000 };

try {
  writeFileSync(join(root, 'openapi.json'), JSON.stringify(spec));
  await client.connect(transport, timeout);
  assert.equal(client.getServerVersion()?.version, version);
  assert.equal((await client.listTools(undefined, timeout)).tools[0]?.name, 'openapi_query');
  const index = await client.readResource({ uri }, timeout);
  assert.deepEqual(JSON.parse(index.contents[0].text).endpoints[0].statusCodes, ['200', '422']);
  await client.getPrompt({ name: 'sync-frontend-api', arguments: { endpoint: 'GET /items' } }, timeout);
  const result = await client.callTool({
    name: 'openapi_query',
    arguments: { code: "spec.paths['/items'].get.responses" },
  }, undefined, timeout);
  assert.equal(result.isError ?? false, false);
  assert.deepEqual(result.structuredContent, spec.paths['/items'].get.responses);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  console.log('MCP stdio smoke passed.');
} finally {
  await client.close();
  rmSync(root, { recursive: true, force: true });
}
