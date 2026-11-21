import { parse, type Node } from 'acorn';
import { newQuickJSWASMModuleFromVariant, Scope, type QuickJSContext, type QuickJSHandle } from 'quickjs-emscripten-core';
import { MAX_RESULT_BYTES } from './budget.js';
import { serializeSpec } from './spec-loader.js';

export const DEFAULT_SANDBOX_TIMEOUT_MS = 150;
export const MAX_QUERY_CODE_LENGTH = 16 * 1024;

const GUEST_MEMORY_BYTES = 64 * 1024 * 1024;
const GUEST_STACK_BYTES = 512 * 1024;
const QuickJS = await newQuickJSWASMModuleFromVariant(import('@jitl/quickjs-singlefile-cjs-release-sync'));

export interface SandboxQueryOptions {
  timeoutMs?: number;
}

export interface SandboxQueryResult {
  value: unknown;
  durationMs: number;
}

const hostIdentifiers = new Set([
  'process', 'Bun', 'require', 'fetch', 'XMLHttpRequest', 'WebSocket',
  'Worker', 'SharedArrayBuffer', 'Atomics', 'eval', 'Function', 'fs', 'net',
  'child_process', 'dgram', 'dns', 'tls', 'cluster', 'v8', 'vm', '__dirname', '__filename',
]);
const metaProperties = new Set(['constructor', '__proto__', 'prototype']);

interface AstNode extends Node {
  [key: string]: unknown;
}

function isNode(value: unknown): value is AstNode {
  return value !== null && typeof value === 'object' && 'type' in value;
}

function prepareQuery(code: string): string {
  if (!code.trim() || code.length > MAX_QUERY_CODE_LENGTH) {
    throw new Error(`SANDBOX_SYNTAX_ERROR: Query code must contain 1 to ${MAX_QUERY_CODE_LENGTH} characters.`);
  }

  // Parse exactly the source the guest will execute. An expression is tried first
  // so object literals, arrow functions and optional chaining work without a return.
  for (const body of [false, true]) {
    const source = body ? `"use strict";\n(() => {\n${code}\n})` : `"use strict";\n(\n${code}\n)`;
    let program;
    try {
      program = parse(source, { ecmaVersion: 'latest' });
    } catch {
      continue;
    }
    const statement = program.body[1];
    if (program.body.length !== 2 || statement?.type !== 'ExpressionStatement' ||
        (body && statement.expression.type !== 'ArrowFunctionExpression')) {
      continue;
    }

    // This check provides actionable errors for unsupported APIs. The guest
    // runtime owns isolation and receives no host objects or callbacks.
    const stack: Array<{ node: AstNode; parent?: AstNode; key?: string }> = [
      { node: statement.expression as unknown as AstNode },
    ];
    while (stack.length > 0) {
      const { node, parent, key } = stack.pop()!;
      const staticMember = parent?.type === 'MemberExpression' && key === 'property';
      const globalMember = staticMember && isNode(parent?.object) &&
        parent.object.type === 'Identifier' && parent.object.name === 'globalThis';
      const objectKey = parent?.type === 'Property' && key === 'key' && !parent.computed;
      if (node.type === 'ImportExpression' ||
          (node.type === 'Identifier' && typeof node.name === 'string' && !objectKey &&
            (staticMember && !parent?.computed
              ? metaProperties.has(node.name) || (globalMember && hostIdentifiers.has(node.name))
              : hostIdentifiers.has(node.name))) ||
          (node.type === 'Literal' && staticMember && typeof node.value === 'string' &&
            metaProperties.has(node.value))) {
        throw new Error('SANDBOX_FORBIDDEN_API: Use standard synchronous JavaScript against spec.');
      }
      for (const [childKey, value] of Object.entries(node)) {
        if (isNode(value)) stack.push({ node: value, parent: node, key: childKey });
        if (Array.isArray(value)) {
          for (const child of value) {
            if (isNode(child)) stack.push({ node: child, parent: node, key: childKey });
          }
        }
      }
    }
    return source;
  }

  throw new Error('SANDBOX_SYNTAX_ERROR: Use a JavaScript expression or a statement body with return.');
}

export function validateSandboxCode(code: string): void {
  prepareQuery(code);
}

/** Runs and serializes the query within one bounded guest runtime. */
export function evaluateSandboxQuery(
  spec: unknown,
  code: string,
  options: SandboxQueryOptions = {}
): { text: string | undefined; durationMs: number } {
  const source = prepareQuery(code);
  const specJson = serializeSpec(spec);

  const configuredTimeout = options.timeoutMs;
  const timeoutMs = configuredTimeout !== undefined && Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_SANDBOX_TIMEOUT_MS;
  const startedAt = performance.now();
  const deadline = startedAt + timeoutMs;
  let interrupted = false;
  return Scope.withScope((scope) => {
    const runtime = scope.manage(QuickJS.newRuntime());
    runtime.setMemoryLimit(GUEST_MEMORY_BYTES);
    runtime.setMaxStackSize(GUEST_STACK_BYTES);
    runtime.setInterruptHandler(() => {
      interrupted ||= performance.now() >= deadline;
      return interrupted;
    });
    const context = scope.manage(runtime.newContext());

    function unwrap(result: ReturnType<QuickJSContext["evalCode"]>, errorCode: string): QuickJSHandle {
      if (result.error) {
        result.error.dispose();
        if (interrupted) throw new Error(`SANDBOX_TIMEOUT: Query exceeded ${timeoutMs}ms. Narrow the query.`);
        throw new Error(`${errorCode}: Guest evaluation failed. Check the query, JSON output, and resource limits.`);
      }
      return scope.manage(result.value);
    }

    const serialize = unwrap(context.evalCode(`
      "use strict";
      (() => {
        const stringify = JSON.stringify;
        const freeze = (value) => {
          if (value !== null && typeof value === "object") {
            for (const child of Object.values(value)) freeze(child);
            Object.freeze(value);
          }
          return value;
        };
        Object.defineProperty(globalThis, "spec", {
          value: freeze(JSON.parse(${JSON.stringify(specJson)})), enumerable: true
        });
        Object.freeze(Object.prototype);
        Object.freeze(Array.prototype);
        return (value) => {
          if (value != null && typeof value.then === "function") return false;
          const text = stringify(value, null, 2);
          return text?.length > ${MAX_RESULT_BYTES} ? 0 : text;
        };
      })()
    `), 'SANDBOX_LIMIT');

    let result = unwrap(context.evalCode(source, 'openapi-query.js', { type: 'global' }), 'SANDBOX_RUNTIME_ERROR');
    if (context.typeof(result) === 'function') {
      const specHandle = scope.manage(context.getProp(context.global, 'spec'));
      result = unwrap(context.callFunction(result, context.undefined, specHandle), 'SANDBOX_RUNTIME_ERROR');
    }
    const json = unwrap(context.callFunction(serialize, context.undefined, result), 'SANDBOX_RESULT_ERROR');
    if (performance.now() >= deadline) throw new Error(`SANDBOX_TIMEOUT: Query exceeded ${timeoutMs}ms.`);
    const resultType = context.typeof(json);
    if (resultType === 'boolean') {
      throw new Error('SANDBOX_ASYNC_FORBIDDEN: Return a synchronous JSON value.');
    }
    const text = resultType === 'string' ? context.getString(json) : undefined;
    if (resultType === 'number' || (text !== undefined && Buffer.byteLength(text) > MAX_RESULT_BYTES)) {
      throw new Error(`SANDBOX_LIMIT: Serialized result exceeds ${MAX_RESULT_BYTES} bytes. Narrow the query.`);
    }
    return { text, durationMs: Math.round(performance.now() - startedAt) };
  });
}

export function runSandboxQuery(
  spec: unknown,
  code: string,
  options: SandboxQueryOptions = {}
): SandboxQueryResult {
  const { text, durationMs } = evaluateSandboxQuery(spec, code, options);
  return { value: text === undefined ? undefined : JSON.parse(text), durationMs };
}
