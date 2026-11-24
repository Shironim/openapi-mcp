#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  diagnoseOpenApiSpec,
  diffOpenApiSpecs,
  loadOpenApiSpec,
} from './engine/index.js';
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

function writeStdout(message: string): void {
  process.stdout.write(message.endsWith('\n') ? message : `${message}\n`);
}

function getHelpText(): string {
  return [
    `openapi-mcp v${OPENAPI_MCP_VERSION} — Local OpenAPI MCP server and contract CLI`,
    '',
    'Usage:',
    '  openapi-mcp <command> [options]',
    '',
    'Commands:',
    '  serve                         Start the MCP server over stdio (default when stdin is piped)',
    '  check                         Validate an OpenAPI spec and report contract issues',
    '  diff <base> <target>          Compare two OpenAPI specs for breaking changes',
    '',
    'Options:',
    '  --root <dir>                  Workspace root directory (defaults to current directory)',
    '  --spec <path>                 Path to OpenAPI spec file (serve, check)',
    '  --strict                      Exit with code 1 if warnings are found (check)',
    '  --fail-on-breaking            Exit with code 1 if breaking changes are found (diff)',
    '  --json                        Output results as JSON (check, diff)',
    '  -h, --help                    Show this help message',
    '  -v, --version                 Show version number',
    '',
    'Examples:',
    '  openapi-mcp serve --root . --spec openapi.yml',
    '  openapi-mcp check --root . --strict',
    '  openapi-mcp diff openapi.yml openapi-v2.yml --fail-on-breaking',
  ].join('\n');
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function readFlagValue(
  argv: string[],
  index: number,
  flag: '--root' | '--spec',
  valueLabel: string,
  placeholder: string
): { value: string; nextIndex: number } | undefined {
  const arg = argv[index]!;
  if (arg === flag) {
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing ${valueLabel} for '${flag}'. Pass '${flag} ${placeholder}'.`);
    }
    return { value, nextIndex: index + 1 };
  }
  if (arg.startsWith(`${flag}=`)) {
    const value = arg.slice(flag.length + 1);
    if (!value) {
      throw new Error(`Missing ${valueLabel} for '${flag}'. Pass '${flag} ${placeholder}'.`);
    }
    return { value, nextIndex: index };
  }
  return undefined;
}

export interface CheckCliOptions {
  rootDir?: string;
  specPath?: string;
  strict?: boolean;
  json?: boolean;
}

export interface DiffCliOptions {
  baseSpecPath: string;
  targetSpecPath: string;
  rootDir?: string;
  failOnBreaking?: boolean;
  json?: boolean;
}

export type ParsedCliCommand =
  | { action: 'help'; options: OpenApiMcpServerOptions }
  | { action: 'version'; options: OpenApiMcpServerOptions }
  | { action: 'serve'; options: OpenApiMcpServerOptions }
  | { action: 'check'; options: CheckCliOptions }
  | { action: 'diff'; options: DiffCliOptions };

export function parseCliArgs(argv: string[], isTTY: boolean): ParsedCliCommand {
  if (argv.length === 0) {
    return isTTY
      ? { action: 'help', options: {} }
      : { action: 'serve', options: {} };
  }

  if (argv[0] === 'check') {
    const checkOptions: CheckCliOptions = {};
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === '--help' || arg === '-h') return { action: 'help', options: {} };
      if (arg === '--strict') {
        checkOptions.strict = true;
        continue;
      }
      if (arg === '--json') {
        checkOptions.json = true;
        continue;
      }
      const rootFlag = readFlagValue(argv, i, '--root', 'directory path', '<dir>');
      if (rootFlag) {
        checkOptions.rootDir = rootFlag.value;
        i = rootFlag.nextIndex;
        continue;
      }
      const specFlag = readFlagValue(argv, i, '--spec', 'file path', '<path>');
      if (specFlag) {
        checkOptions.specPath = specFlag.value;
        i = specFlag.nextIndex;
        continue;
      }
      throw new Error(`Unknown option for 'check': '${arg}'. Run 'openapi-mcp --help' for usage.`);
    }
    return { action: 'check', options: checkOptions };
  }

  if (argv[0] === 'diff') {
    const positionals: string[] = [];
    let rootDir: string | undefined;
    let failOnBreaking = false;
    let json = false;
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === '--help' || arg === '-h') return { action: 'help', options: {} };
      if (arg === '--fail-on-breaking') {
        failOnBreaking = true;
        continue;
      }
      if (arg === '--json') {
        json = true;
        continue;
      }
      const rootFlag = readFlagValue(argv, i, '--root', 'directory path', '<dir>');
      if (rootFlag) {
        rootDir = rootFlag.value;
        i = rootFlag.nextIndex;
        continue;
      }
      if (arg.startsWith('-')) {
        throw new Error(`Unknown option for 'diff': '${arg}'. Run 'openapi-mcp --help' for usage.`);
      }
      positionals.push(arg);
    }
    if (positionals.length < 2) {
      throw new Error("Missing spec path(s) for 'diff'. Usage: openapi-mcp diff <base> <target> [options]");
    }
    if (positionals.length > 2) {
      throw new Error(`Unexpected argument '${positionals[2]}' for 'diff'. Expected two spec paths: <base> <target>.`);
    }
    return {
      action: 'diff',
      options: {
        baseSpecPath: positionals[0]!,
        targetSpecPath: positionals[1]!,
        ...(rootDir ? { rootDir } : {}),
        failOnBreaking,
        json,
      },
    };
  }

  let i = 0;
  const options: OpenApiMcpServerOptions = {};

  if (argv[0] === 'serve') {
    i = 1;
  }

  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      return { action: 'help', options: {} };
    }
    if (arg === '--version' || arg === '-v') {
      if (argv.length > 1) {
        throw new Error(`Unexpected arguments alongside '${arg}': ${argv.join(' ')}`);
      }
      return { action: 'version', options: {} };
    }
    const rootFlag = readFlagValue(argv, i, '--root', 'directory path', '<dir>');
    if (rootFlag) {
      options.defaultRootDir = rootFlag.value;
      i = rootFlag.nextIndex;
      continue;
    }
    const specFlag = readFlagValue(argv, i, '--spec', 'file path', '<path>');
    if (specFlag) {
      options.defaultSpecPath = specFlag.value;
      i = specFlag.nextIndex;
      continue;
    }

    throw new Error(`Unknown command or option: '${arg}'. Run 'openapi-mcp --help' for usage.`);
  }

  return { action: 'serve', options };
}

export function runCheckCommand(options: CheckCliOptions): number {
  const report = diagnoseOpenApiSpec({
    rootDir: options.rootDir,
    specPath: options.specPath,
    allowedRootDir: options.rootDir,
  });

  if (options.json) {
    writeStdout(JSON.stringify(report, null, 2));
  } else {
    const status = report.valid ? 'OK' : 'FAILED';
    writeStdout(
      `[openapi-mcp check] ${status} — ${pluralize(report.summary.errors, 'error')}, ${pluralize(report.summary.warnings, 'warning')} (${report.specPath})`
    );
    for (const issue of report.issues) {
      const loc = issue.location ? ` (${issue.location.file}:${issue.location.line})` : '';
      writeStdout(`  [${issue.severity.toUpperCase()}] ${issue.code}${loc}: ${issue.message}`);
    }
  }

  if (!report.valid) return 1;
  if (options.strict && report.summary.warnings > 0) return 1;
  return 0;
}

export function runDiffCommand(options: DiffCliOptions): number {
  const rootDir = options.rootDir ?? process.cwd();
  const baseLoaded = loadOpenApiSpec({ rootDir, specPath: options.baseSpecPath, allowedRootDir: options.rootDir });
  const targetLoaded = loadOpenApiSpec({ rootDir, specPath: options.targetSpecPath, allowedRootDir: options.rootDir });
  const report = diffOpenApiSpecs(baseLoaded.spec, targetLoaded.spec, {
    base: options.baseSpecPath,
    target: options.targetSpecPath,
  });

  if (options.json) {
    writeStdout(JSON.stringify(report, null, 2));
  } else {
    writeStdout(
      `[openapi-mcp diff] ${options.baseSpecPath} -> ${options.targetSpecPath}: ${report.summary.breakingCount} breaking, ${report.summary.nonBreakingCount} non-breaking`
    );
    for (const change of report.breaking) {
      writeStdout(`  [BREAKING] ${change.code} (${change.endpoint}): ${change.message}`);
    }
    for (const change of report.nonBreaking) {
      writeStdout(`  [NON_BREAKING] ${change.code} (${change.endpoint}): ${change.message}`);
    }
  }

  return options.failOnBreaking && report.hasBreakingChanges ? 1 : 0;
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
    } else if (parsed.action === 'check') {
      process.exit(runCheckCommand(parsed.options));
    } else if (parsed.action === 'diff') {
      process.exit(runDiffCommand(parsed.options));
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
