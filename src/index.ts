#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  OPENAPI_MCP_INSTRUCTIONS,
  OPENAPI_MCP_VERSION,
  OPENAPI_PROMPTS,
  OPENAPI_RESOURCES,
  OPENAPI_TOOLS,
  createOpenApiMcpServer,
  getOpenApiPrompt,
  type OpenApiMcpServerOptions,
} from './mcp/server.js';

export * from './engine/index.js';
export {
  OPENAPI_MCP_INSTRUCTIONS,
  OPENAPI_MCP_VERSION,
  OPENAPI_PROMPTS,
  OPENAPI_RESOURCES,
  OPENAPI_TOOLS,
  createOpenApiMcpServer,
  getOpenApiPrompt,
  type OpenApiMcpServerOptions,
};

function writeStderr(message: string): void {
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
}

function getHelpText(): string {
  return [
    `openapi-mcp v${OPENAPI_MCP_VERSION} — Local Code Mode MCP Server for OpenAPI`,
    '',
    'Usage:',
    '  openapi-mcp serve [--root <dir>] [--spec <path>]   Start MCP server over stdio',
    '  openapi-mcp                                        Auto-start stdio when stdin is piped (!isTTY)',
    '  openapi-mcp --help | -h                            Show this help message',
    '  openapi-mcp --version | -v                         Show version',
    '',
    'MCP Primitives:',
    '  Resource: openapi://endpoints/index (application/json)',
    '  Tool:     openapi_query (read-only sandboxed JS query against resolved `spec`)',
    '  Prompts:  sync-frontend-api, audit-error-contracts',
  ].join('\n');
}

export interface ParsedCliCommand {
  action: 'help' | 'version' | 'serve';
  options: OpenApiMcpServerOptions;
}

export function parseCliArgs(argv: string[], isTTY: boolean): ParsedCliCommand {
  if (argv.length === 0) {
    return isTTY
      ? { action: 'help', options: {} }
      : { action: 'serve', options: {} };
  }

  let i = 0;
  let explicitServe = false;
  const options: OpenApiMcpServerOptions = {};

  if (argv[0] === 'serve') {
    explicitServe = true;
    i = 1;
  }

  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      if (argv.length > 1 && !explicitServe) {
        throw new Error(`Unexpected arguments alongside '${arg}': ${argv.join(' ')}`);
      }
      return { action: 'help', options: {} };
    }
    if (arg === '--version' || arg === '-v') {
      if (argv.length > 1) {
        throw new Error(`Unexpected arguments alongside '${arg}': ${argv.join(' ')}`);
      }
      return { action: 'version', options: {} };
    }
    if (arg === '--root') {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for '--root'.");
      options.defaultRootDir = value;
      continue;
    }
    if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length);
      if (!value) throw new Error("Missing value for '--root='.");
      options.defaultRootDir = value;
      continue;
    }
    if (arg === '--spec') {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for '--spec'.");
      options.defaultSpecPath = value;
      continue;
    }
    if (arg.startsWith('--spec=')) {
      const value = arg.slice('--spec='.length);
      if (!value) throw new Error("Missing value for '--spec='.");
      options.defaultSpecPath = value;
      continue;
    }

    throw new Error(`Unknown command or option: '${arg}'. Run with --help for usage.`);
  }

  return { action: 'serve', options };
}

export async function runStdioServer(options: OpenApiMcpServerOptions = {}): Promise<void> {
  const server = createOpenApiMcpServer(options);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    writeStderr(`[openapi-mcp] Shutting down (${reason})...`);
    try {
      await server.close();
    } catch {
      // Ignore close errors during shutdown
    }
    process.exit(exitCode);
  };

  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.stdin.on('close', () => void shutdown('stdin:close', 0));
  process.stdin.on('end', () => void shutdown('stdin:end', 0));

  transport.onclose = () => void shutdown('transport:close', 0);
  server.onclose = () => void shutdown('server:close', 0);

  transport.onerror = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    writeStderr(`[openapi-mcp] Transport error: ${message}`);
  };

  await server.connect(transport);
  writeStderr(`[openapi-mcp] stdio server ready (v${OPENAPI_MCP_VERSION}, pid=${process.pid}).`);
}

const isDirectExecution = (() => {
  try {
    const entryPath = fileURLToPath(import.meta.url);
    if (entryPath.includes('$bunfs') || entryPath.includes('~BUN')) return true;
    return Boolean(process.argv[1] && realpathSync(process.argv[1]) === realpathSync(entryPath));
  } catch {
    return false;
  }
})();

if (isDirectExecution) {
  const argv = process.argv.slice(2);
  try {
    const parsed = parseCliArgs(argv, Boolean(process.stdin.isTTY));
    if (parsed.action === 'help') {
      writeStderr(getHelpText());
      process.exit(0);
    } else if (parsed.action === 'version') {
      writeStderr(OPENAPI_MCP_VERSION);
      process.exit(0);
    } else {
      runStdioServer(parsed.options).catch((err) => {
        const message = err instanceof Error ? err.stack || err.message : String(err);
        writeStderr(`[openapi-mcp] Fatal server error: ${message}`);
        process.exit(1);
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeStderr(`[openapi-mcp] ${message}`);
    process.exit(1);
  }
}
