import { parse, type Node } from 'acorn';
import { newQuickJSWASMModuleFromVariant, Scope, type QuickJSContext, type QuickJSHandle } from 'quickjs-emscripten-core';
import { MAX_RESULT_BYTES } from './budget.js';
import { serializeSpec } from './spec-loader.js';

export const DEFAULT_SANDBOX_TIMEOUT_MS = 150;
export const MAX_QUERY_CODE_LENGTH = 16 * 1024;

const BOOTSTRAP_TIMEOUT_MS = 2_000;
const GUEST_MEMORY_BYTES = 64 * 1024 * 1024;
const GUEST_STACK_BYTES = 512 * 1024;
const QuickJS = await newQuickJSWASMModuleFromVariant(import('@jitl/quickjs-singlefile-cjs-release-sync'));

export interface SandboxMetadata {
  sourceLocations?: Readonly<Record<string, unknown>>;
  schemaUsages?: Readonly<Record<string, unknown>>;
}

export interface SandboxQueryOptions {
  timeoutMs?: number;
  metadata?: SandboxMetadata;
}

const GUEST_HELPERS_SOURCE = `
  const isRec = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const escPtr = (s) => String(s).replace(/~/g, "~0").replace(/\\//g, "~1");
  const pickType = (t) => typeof t === "string" ? t : Array.isArray(t) ? (t.find((x) => typeof x === "string" && x !== "null") ?? t.find((x) => typeof x === "string")) : undefined;
  const synthStr = (s) => {
    const f = typeof s.format === "string" ? s.format.toLowerCase() : "";
    if (f === "uuid") return "00000000-0000-4000-8000-000000000000";
    if (f === "email" || f === "idn-email") return "user@example.com";
    if (f === "date-time") return "2026-01-01T00:00:00Z";
    if (f === "date") return "2026-01-01";
    if (f === "time") return "00:00:00Z";
    if (f === "uri" || f === "url" || f === "iri") return "https://example.com/resource";
    if (f === "ipv4") return "192.0.2.1";
    if (f === "ipv6") return "2001:db8::1";
    if (f === "hostname" || f === "idn-hostname") return "example.com";
    if (f === "byte") return "ZXhhbXBsZQ==";
    const minL = typeof s.minLength === "number" && s.minLength > 0 ? Math.min(64, Math.floor(s.minLength)) : 0;
    return minL > 6 ? "string".padEnd(minL, "x") : "string";
  };
  const synthNum = (s, isInt) => {
    let v = isInt ? 1 : 0;
    if (typeof s.exclusiveMinimum === "number") v = isInt ? Math.floor(s.exclusiveMinimum) + 1 : s.exclusiveMinimum + 0.5;
    else if (typeof s.minimum === "number" && v < s.minimum) v = isInt ? Math.ceil(s.minimum) : s.minimum;
    if (typeof s.maximum === "number" && v > s.maximum) v = isInt ? Math.floor(s.maximum) : s.maximum;
    return v;
  };
  const genExample = (schema, opts = {}) => {
    const maxD = opts.maxDepth ?? 8;
    const maxN = opts.maxNodes ?? 256;
    const incRO = opts.includeReadOnly ?? true;
    const incWO = opts.includeWriteOnly ?? true;
    let nodes = 0;
    const visit = (n, d) => {
      if (++nodes > maxN || d > maxD) return null;
      if (typeof n === "string" && n.startsWith("[Circular:")) return null;
      if (typeof n === "boolean") return n ? {} : null;
      if (!isRec(n)) return null;
      if (n.example !== undefined) return n.example;
      if (Array.isArray(n.examples) && n.examples.length > 0) return n.examples[0];
      if (n.const !== undefined) return n.const;
      if (n.default !== undefined) return n.default;
      if (Array.isArray(n.enum) && n.enum.length > 0) return n.enum[0];
      if (Array.isArray(n.allOf) && n.allOf.length > 0) {
        const merged = {};
        let anyObj = false;
        for (const b of n.allOf) {
          const s = visit(b, d + 1);
          if (isRec(s)) { Object.assign(merged, s); anyObj = true; }
        }
        return anyObj ? merged : visit(n.allOf[0], d + 1);
      }
      const union = Array.isArray(n.oneOf) ? n.oneOf : Array.isArray(n.anyOf) ? n.anyOf : null;
      if (union && union.length > 0) {
        const pick = union.find((b) => isRec(b) && b.type !== "null") ?? union[0];
        return visit(pick, d + 1);
      }
      const t = pickType(n.type) ?? (isRec(n.properties) ? "object" : n.items !== undefined ? "array" : undefined);
      if (t === "object") {
        const out = {};
        if (isRec(n.properties)) {
          for (const [k, ps] of Object.entries(n.properties)) {
            if (isRec(ps) && ((!incRO && ps.readOnly === true) || (!incWO && ps.writeOnly === true))) continue;
            out[k] = visit(ps, d + 1);
          }
        }
        return out;
      }
      if (t === "array") {
        if (Array.isArray(n.prefixItems) && n.prefixItems.length > 0) return n.prefixItems.map((x) => visit(x, d + 1));
        if (n.items === undefined) return [];
        const cnt = typeof n.minItems === "number" && n.minItems > 0 ? Math.min(2, Math.floor(n.minItems)) : 1;
        const arr = [];
        for (let i = 0; i < cnt; i++) arr.push(visit(n.items, d + 1));
        return arr;
      }
      if (t === "string") return synthStr(n);
      if (t === "integer") return synthNum(n, true);
      if (t === "number") return synthNum(n, false);
      if (t === "boolean") return true;
      return null;
    };
    return visit(schema, 0);
  };
  const pickMedia = (content) => {
    if (isRec(content["application/json"])) return { mediaType: "application/json", media: content["application/json"] };
    const jKey = Object.keys(content).find((k) => k.includes("json") && isRec(content[k]));
    if (jKey) return { mediaType: jKey, media: content[jKey] };
    const fKey = Object.keys(content).find((k) => isRec(content[k]));
    return fKey ? { mediaType: fKey, media: content[fKey] } : null;
  };
  const extractMediaEx = (media, opts) => {
    if (media.example !== undefined) return media.example;
    if (isRec(media.examples)) {
      for (const ex of Object.values(media.examples)) {
        if (isRec(ex) && ex.value !== undefined) return ex.value;
      }
    }
    return media.schema !== undefined ? genExample(media.schema, opts) : null;
  };
  const getOp = (method, path) => {
    const specObj = globalThis.spec;
    const paths = isRec(specObj?.paths) ? specObj.paths : null;
    const item = paths && isRec(paths[path]) ? paths[path] : null;
    const m = String(method ?? "").trim().toLowerCase();
    const op = item && isRec(item[m]) ? item[m] : null;
    if (!item || !op) return null;
    const paramMap = new Map();
    const addP = (list) => {
      if (!Array.isArray(list)) return;
      for (const p of list) {
        if (isRec(p) && typeof p.name === "string" && typeof p.in === "string") paramMap.set(p.in + ":" + p.name, p);
      }
    };
    addP(item.parameters);
    addP(op.parameters);
    const sec = Array.isArray(op.security) ? op.security : Array.isArray(specObj.security) ? specObj.security : undefined;
    const loc = __meta?.sourceLocations?.["/paths/" + escPtr(path) + "/" + m];
    const res = { method: m.toUpperCase(), path, parameters: [...paramMap.values()] };
    if (typeof op.operationId === "string") res.operationId = op.operationId;
    if (typeof op.summary === "string") res.summary = op.summary;
    if (typeof op.description === "string") res.description = op.description;
    if (Array.isArray(op.tags)) res.tags = op.tags;
    if (op.deprecated === true) res.deprecated = true;
    if (sec !== undefined) res.security = sec;
    if (op.requestBody !== undefined) res.requestBody = op.requestBody;
    if (op.responses !== undefined) res.responses = op.responses;
    if (loc) res.sourceLocation = loc;
    return res;
  };
  const exampleHelper = (first, second, third) => {
    if (typeof first === "string" && typeof second === "string") {
      const op = getOp(first, second);
      if (!op) return null;
      const out = { method: op.method, path: op.path, responses: {} };
      if (isRec(op.requestBody) && isRec(op.requestBody.content)) {
        const picked = pickMedia(op.requestBody.content);
        if (picked) out.requestBody = { mediaType: picked.mediaType, example: extractMediaEx(picked.media, { includeReadOnly: false, includeWriteOnly: true }) };
      }
      if (isRec(op.responses)) {
        const codes = third !== undefined ? [String(third)] : Object.keys(op.responses);
        for (const c of codes) {
          const r = op.responses[c];
          if (!isRec(r)) continue;
          if (isRec(r.content)) {
            const picked = pickMedia(r.content);
            if (picked) { out.responses[c] = { mediaType: picked.mediaType, example: extractMediaEx(picked.media, { includeReadOnly: true, includeWriteOnly: false }) }; continue; }
          }
          if (r.schema !== undefined) out.responses[c] = { example: genExample(r.schema, { includeReadOnly: true, includeWriteOnly: false }) };
        }
      }
      return out;
    }
    return genExample(first, isRec(second) ? second : {});
  };
  const schemaRefsHelper = (name) => {
    const usages = __meta?.schemaUsages ?? {};
    if (name === undefined) return usages;
    return usages[String(name)] ?? [];
  };
  Object.defineProperty(globalThis, "helpers", {
    value: Object.freeze({
      op: Object.freeze(getOp),
      example: Object.freeze(exampleHelper),
      schemaRefs: Object.freeze(schemaRefsHelper),
    }),
    enumerable: true,
  });
`;

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

const metaJsonCache = new WeakMap<object, string>();

function serializeMetadata(metadata?: SandboxMetadata): string {
  if (!metadata) return '{}';
  const cached = metaJsonCache.get(metadata);
  if (cached !== undefined) return cached;
  const text = JSON.stringify(metadata);
  metaJsonCache.set(metadata, text);
  return text;
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
  let deadline = performance.now() + Math.max(BOOTSTRAP_TIMEOUT_MS, timeoutMs);
  let interrupted = false;
  let phase: 'bootstrap' | 'query' = 'bootstrap';
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
        if (interrupted) {
          if (phase === 'bootstrap') {
            throw new Error('SANDBOX_LIMIT: Spec bootstrap exceeded time limit.');
          }
          throw new Error(`SANDBOX_TIMEOUT: Query exceeded ${timeoutMs}ms. Narrow the query.`);
        }
        throw new Error(`${errorCode}: Guest evaluation failed. Check the query, JSON output, and resource limits.`);
      }
      return scope.manage(result.value);
    }

    const metaJson = serializeMetadata(options.metadata);
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
        const __meta = freeze(JSON.parse(${JSON.stringify(metaJson)}));
        Object.defineProperty(globalThis, "spec", {
          value: freeze(JSON.parse(${JSON.stringify(specJson)})), enumerable: true
        });
        ${GUEST_HELPERS_SOURCE}
        Object.freeze(Object.prototype);
        Object.freeze(Array.prototype);
        return (value) => {
          if (value != null && typeof value.then === "function") return false;
          const text = stringify(value, null, 2);
          return text?.length > ${MAX_RESULT_BYTES} ? 0 : text;
        };
      })()
    `), 'SANDBOX_LIMIT');

    // Measure query execution timeout independently of guest spec parse/freeze bootstrap.
    phase = 'query';
    const queryStartedAt = performance.now();
    deadline = queryStartedAt + timeoutMs;
    interrupted = false;

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
    return { text, durationMs: Math.round(performance.now() - queryStartedAt) };
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
