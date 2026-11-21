#!/bin/sh
set -eu

project=$(pwd)
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT
archive=$(npm pack --silent --pack-destination "$temp")
tar -tzf "$temp/$archive" > "$temp/entries"
if grep -Eq '^package/(release/|dist/openapi-mcp-)' "$temp/entries"; then
  echo 'Standalone binary found in npm archive.' >&2
  exit 1
fi
mkdir "$temp/consumer"
cd "$temp/consumer"
npm install --ignore-scripts --no-audit --no-fund "$temp/$archive" @types/node@22

cat > consumer.mts <<'TS'
import assert from 'node:assert/strict';
import { buildEndpointIndex as fromRoot, clearSpecCache as clearRoot } from '@dimassetoid/openapi-mcp';
import { buildEndpointIndex as fromEngine, clearSpecCache as clearEngine } from '@dimassetoid/openapi-mcp/engine';

assert.equal(fromRoot, fromEngine);
assert.equal(clearRoot, clearEngine);
assert.equal(fromEngine({ paths: {} }).totalEndpoints, 0);
TS
"$project/node_modules/.bin/tsc" --strict --module NodeNext consumer.mts
node consumer.mjs
node "$project/scripts/smoke-stdio.mjs" node "$temp/consumer/node_modules/@dimassetoid/openapi-mcp/dist/index.js"
