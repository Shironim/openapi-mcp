#!/usr/bin/env bun
import { mkdirSync } from 'node:fs';

const targets = [
  { target: 'bun-linux-x64', outfile: 'release/openapi-mcp-linux-x64' },
  { target: 'bun-linux-arm64', outfile: 'release/openapi-mcp-linux-arm64' },
  { target: 'bun-darwin-x64', outfile: 'release/openapi-mcp-darwin-x64' },
  { target: 'bun-darwin-arm64', outfile: 'release/openapi-mcp-darwin-arm64' },
  { target: 'bun-windows-x64', outfile: 'release/openapi-mcp-windows-x64.exe' },
] as const;

const requestedTarget = process.argv[2];
const targetsToBuild = requestedTarget
  ? targets.filter((t) => t.target === requestedTarget || t.target === `bun-${requestedTarget}`)
  : targets;

if (targetsToBuild.length === 0) {
  console.error(`Unknown target: ${requestedTarget}`);
  process.exit(1);
}

mkdirSync('release', { recursive: true });

for (const { target, outfile } of targetsToBuild) {
  console.log(`Compiling ${target} -> ${outfile}...`);
  const result = await Bun.build({
    entrypoints: ['./src/index.ts'],
    target: 'bun',
    compile: {
      target,
      outfile,
    },
  });

  if (!result.success) {
    console.error(`Failed to compile ${target}:`, result.logs);
    process.exit(1);
  }
}

console.log('Compilation completed successfully.');
