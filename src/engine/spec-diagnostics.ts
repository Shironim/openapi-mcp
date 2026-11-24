import { dirname, relative } from 'node:path';
import { HTTP_METHODS } from './index-builder.js';
import { isRecord } from './json.js';
import { escapeJsonPointer, parseDocumentWithLocations, type SourceLocation } from './source-map.js';
import {
  MAX_SPEC_BYTES,
  MAX_SPEC_FILES,
  assertWorkspaceRoot,
  findOpenApiSpecFile,
  readBoundedFileSnapshot,
  resolveJsonPointerSafe,
  resolveSafeSpecPath,
  type LoadOpenApiSpecOptions,
} from './spec-loader.js';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface SpecDiagnosticIssue {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  pointer?: string;
  location?: SourceLocation;
}

export interface SpecDiagnosticsReport {
  valid: boolean;
  specPath: string;
  summary: {
    errors: number;
    warnings: number;
    info: number;
    totalIssues: number;
    truncated: boolean;
  };
  issues: SpecDiagnosticIssue[];
}

const MAX_DIAGNOSTIC_ISSUES = 200;
const MAX_DIAGNOSTIC_VISITS = 250_000;
const MAX_DIAGNOSTIC_DEPTH = 128;

function extractPathTemplateParams(pathKey: string): string[] {
  const params: string[] = [];
  const regex = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(pathKey)) !== null) {
    const name = match[1]?.trim();
    if (name) params.push(name);
  }
  return params;
}

/**
 * Performs a non-throwing, multi-issue structural & contract diagnostic pass on an OpenAPI spec.
 * Enforces the same workspace boundary, `O_NOFOLLOW`, cumulative byte (`MAX_SPEC_BYTES`),
 * and file-count (`MAX_SPEC_FILES`) bounds as `loadOpenApiSpec`.
 */
export function diagnoseOpenApiSpec(options: LoadOpenApiSpecOptions = {}): SpecDiagnosticsReport {
  const rootInput = options.rootDir?.trim() || process.cwd();
  const rootReal = assertWorkspaceRoot(rootInput, options.allowedRootDir);
  const entryPath = findOpenApiSpecFile(rootInput, options.specPath);
  const relEntry = relative(rootReal, entryPath).replace(/\\/g, '/');

  const issues: SpecDiagnosticIssue[] = [];
  let truncated = false;
  const pushIssue = (issue: SpecDiagnosticIssue) => {
    if (issues.length >= MAX_DIAGNOSTIC_ISSUES) {
      truncated = true;
      return;
    }
    issues.push(issue);
  };

  const parsedCache = new Map<string, { value: unknown; locations: Map<string, SourceLocation> } | { error: string }>();
  let remainingBytes = MAX_SPEC_BYTES;
  let loadedFiles = 0;

  function loadRawFile(canonicalPath: string): { value: unknown; locations: Map<string, SourceLocation> } | { error: string } {
    const cached = parsedCache.get(canonicalPath);
    if (cached) return cached;
    if (loadedFiles >= MAX_SPEC_FILES) {
      const res = { error: `SPEC_LIMIT: At most ${MAX_SPEC_FILES} source files are supported.` };
      parsedCache.set(canonicalPath, res);
      return res;
    }
    try {
      const file = readBoundedFileSnapshot(canonicalPath, remainingBytes);
      remainingBytes -= file.size;
      loadedFiles++;
      const rel = relative(rootReal, canonicalPath).replace(/\\/g, '/');
      const parsed = parseDocumentWithLocations(file.content, rel);
      parsedCache.set(canonicalPath, parsed);
      return parsed;
    } catch (err) {
      const res = { error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
      parsedCache.set(canonicalPath, res);
      return res;
    }
  }

  const entryParsed = loadRawFile(entryPath);
  if ('error' in entryParsed) {
    pushIssue({
      severity: 'error',
      code: 'SPEC_PARSE_ERROR',
      message: entryParsed.error,
      location: { file: relEntry, line: 1, col: 1 },
    });
    return finalizeReport(entryPath, issues, truncated);
  }

  if (!isRecord(entryParsed.value)) {
    pushIssue({
      severity: 'error',
      code: 'SPEC_PARSE_ERROR',
      message: 'Root OpenAPI document must be a YAML/JSON object.',
      location: { file: relEntry, line: 1, col: 1 },
    });
    return finalizeReport(entryPath, issues, truncated);
  }

  const doc = entryParsed.value;
  const locMap = entryParsed.locations;

  if (typeof doc.openapi !== 'string' && typeof doc.swagger !== 'string') {
    pushIssue({
      severity: 'error',
      code: 'MISSING_OPENAPI_VERSION',
      message: 'Document must declare either an "openapi" (3.x) or "swagger" ("2.0") version field.',
      pointer: '',
    });
  }

  if (!isRecord(doc.info) || typeof doc.info.title !== 'string' || !doc.info.title.trim()) {
    pushIssue({
      severity: 'warning',
      code: 'MISSING_INFO_TITLE',
      message: 'Document should declare a non-empty "info.title".',
      pointer: '/info',
    });
  }

  // 1. Walk raw document to detect all broken/remote/escaping $refs in one pass.
  let visits = 0;
  const seenObjects = new WeakSet<object>();
  function scanRefs(node: unknown, pointer: string, depth: number, inLiteral: boolean): void {
    if (++visits > MAX_DIAGNOSTIC_VISITS || depth > MAX_DIAGNOSTIC_DEPTH) return;
    if (node === null || typeof node !== 'object') return;
    if (seenObjects.has(node)) return;
    seenObjects.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        scanRefs(node[i], `${pointer}/${i}`, depth + 1, inLiteral);
      }
      return;
    }

    const record = node as Record<string, unknown>;
    if (!inLiteral && typeof record.$ref === 'string') {
      const ref = record.$ref.trim();
      const hash = ref.indexOf('#');
      const filePart = hash < 0 ? ref : ref.slice(0, hash);
      const fragment = hash < 0 ? '' : ref.slice(hash + 1);
      const nearestLoc = findNearestLocation(locMap, pointer);

      let targetDoc: unknown = doc;
      if (filePart) {
        try {
          const targetCanonical = resolveSafeSpecPath(filePart, rootReal, dirname(entryPath), rootInput);
          const loadedTarget = loadRawFile(targetCanonical);
          if ('error' in loadedTarget) {
            pushIssue({
              severity: 'error',
              code: 'REF_PARSE_ERROR',
              message: `Referenced file '${filePart}' failed to parse: ${loadedTarget.error}`,
              pointer,
              ...(nearestLoc ? { location: nearestLoc } : {}),
            });
            return;
          }
          targetDoc = loadedTarget.value;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = msg.startsWith('REMOTE_REF_DENIED:')
            ? 'REMOTE_REF_DENIED'
            : msg.startsWith('PATH_TRAVERSAL_DENIED:')
              ? 'PATH_TRAVERSAL_DENIED'
              : 'BROKEN_REF';
          pushIssue({
            severity: 'error',
            code,
            message: `Broken $ref '${ref}': ${msg}`,
            pointer,
            ...(nearestLoc ? { location: nearestLoc } : {}),
          });
          return;
        }
      }

      const resolved = resolveJsonPointerSafe(targetDoc, fragment);
      if (!resolved.ok) {
        pushIssue({
          severity: 'error',
          code: 'BROKEN_REF',
          message: `Unresolved $ref '${ref}': ${resolved.reason}`,
          pointer,
          ...(nearestLoc ? { location: nearestLoc } : {}),
        });
      }
      return;
    }

    for (const [key, val] of Object.entries(record)) {
      const nextLiteral = inLiteral || key === 'example' || key === 'value' || key.startsWith('x-');
      scanRefs(val, `${pointer}/${escapeJsonPointer(key)}`, depth + 1, nextLiteral);
    }
  }

  scanRefs(doc, '', 0, false);

  // 2. Semantic & contract quality checks across paths/operations.
  const securitySchemes = new Set<string>(
    Object.keys(
      isRecord(doc.components) && isRecord(doc.components.securitySchemes)
        ? doc.components.securitySchemes
        : isRecord(doc.securityDefinitions)
          ? doc.securityDefinitions
          : {}
    )
  );

  const checkSecurity = (secField: unknown, pointer: string, location?: SourceLocation) => {
    if (!Array.isArray(secField)) return;
    for (const req of secField) {
      if (!isRecord(req)) continue;
      for (const schemeName of Object.keys(req)) {
        if (!securitySchemes.has(schemeName)) {
          pushIssue({
            severity: 'error',
            code: 'UNKNOWN_SECURITY_SCHEME',
            message: `Security scheme '${schemeName}' is not declared in components.securitySchemes.`,
            pointer,
            ...(location ? { location } : {}),
          });
        }
      }
    }
  };

  checkSecurity(doc.security, '/security', locMap.get('/security'));

  const seenOperationIds = new Map<string, string>();
  const pathsObj = isRecord(doc.paths) ? doc.paths : {};

  for (const [pathKey, pathItem] of Object.entries(pathsObj)) {
    if (!isRecord(pathItem)) continue;
    const escapedPath = escapeJsonPointer(pathKey);
    const templateParams = extractPathTemplateParams(pathKey);

    const resolveParamObject = (param: unknown): Record<string, unknown> | undefined => {
      if (!isRecord(param)) return undefined;
      if (typeof param.$ref === 'string' && param.$ref.startsWith('#')) {
        const res = resolveJsonPointerSafe(doc, param.$ref.slice(1));
        return res.ok && isRecord(res.value) ? res.value : undefined;
      }
      return param;
    };

    const pathLevelPathParams = new Set<string>();
    if (Array.isArray(pathItem.parameters)) {
      for (const rawParam of pathItem.parameters) {
        const param = resolveParamObject(rawParam);
        if (param && param.in === 'path' && typeof param.name === 'string') {
          pathLevelPathParams.add(param.name);
        }
      }
    }

    for (const httpMethod of HTTP_METHODS) {
      const op = pathItem[httpMethod];
      if (!isRecord(op)) continue;
      const opPointer = `/paths/${escapedPath}/${httpMethod}`;
      const opLoc = locMap.get(opPointer);
      const opLabel = `${httpMethod.toUpperCase()} ${pathKey}`;

      if (typeof op.operationId === 'string' && op.operationId.trim()) {
        const opId = op.operationId.trim();
        const existing = seenOperationIds.get(opId);
        if (existing) {
          pushIssue({
            severity: 'error',
            code: 'DUPLICATE_OPERATION_ID',
            message: `Duplicate operationId '${opId}' on ${opLabel} (already used by ${existing}).`,
            pointer: opPointer,
            ...(opLoc ? { location: opLoc } : {}),
          });
        } else {
          seenOperationIds.set(opId, opLabel);
        }
      }

      if (templateParams.length > 0) {
        const declared = new Set(pathLevelPathParams);
        if (Array.isArray(op.parameters)) {
          for (const rawParam of op.parameters) {
            const param = resolveParamObject(rawParam);
            if (param && param.in === 'path' && typeof param.name === 'string') {
              declared.add(param.name);
            }
          }
        }
        for (const tpl of templateParams) {
          if (!declared.has(tpl)) {
            pushIssue({
              severity: 'error',
              code: 'UNDECLARED_PATH_PARAMETER',
              message: `Path template parameter '{${tpl}}' on ${opLabel} is not declared in parameters with in: "path".`,
              pointer: opPointer,
              ...(opLoc ? { location: opLoc } : {}),
            });
          }
        }
      }

      checkSecurity(op.security, `${opPointer}/security`, opLoc);

      const responses = isRecord(op.responses) ? op.responses : {};
      const errorCodes = Object.keys(responses).filter((c) => /^[45](?:\d{2}|xx)$/i.test(c.trim()));
      if (errorCodes.length === 0) {
        pushIssue({
          severity: 'warning',
          code: 'MISSING_ERROR_CONTRACT',
          message: `Operation ${opLabel} declares no 4xx/5xx error responses.`,
          pointer: opPointer,
          ...(opLoc ? { location: opLoc } : {}),
        });
      } else {
        for (const code of errorCodes) {
          let resp = responses[code];
          if (isRecord(resp) && typeof resp.$ref === 'string' && resp.$ref.startsWith('#')) {
            const resolvedResp = resolveJsonPointerSafe(doc, resp.$ref.slice(1));
            if (resolvedResp.ok) resp = resolvedResp.value;
          }
          if (!isRecord(resp)) continue;
          const content = isRecord(resp.content) ? resp.content : undefined;
          const hasSchema =
            (content && Object.values(content).some((m) => isRecord(m) && (isRecord(m.schema) || typeof m.schema === 'boolean'))) ||
            (doc.swagger === '2.0' && isRecord(resp.schema));
          if (!hasSchema) {
            pushIssue({
              severity: 'warning',
              code: 'ERROR_RESPONSE_MISSING_SCHEMA',
              message: `Error response ${code} on ${opLabel} has no body schema declared.`,
              pointer: `${opPointer}/responses/${escapeJsonPointer(code)}`,
              ...(opLoc ? { location: opLoc } : {}),
            });
          }
        }
      }
    }
  }

  return finalizeReport(entryPath, issues, truncated);
}

function findNearestLocation(locMap: Map<string, SourceLocation>, pointer: string): SourceLocation | undefined {
  let current = pointer;
  while (current.length > 0) {
    const hit = locMap.get(current);
    if (hit) return hit;
    const idx = current.lastIndexOf('/');
    if (idx <= 0) break;
    current = current.slice(0, idx);
  }
  return undefined;
}

function finalizeReport(specPath: string, issues: SpecDiagnosticIssue[], truncated: boolean): SpecDiagnosticsReport {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  for (const issue of issues) {
    if (issue.severity === 'error') errors++;
    else if (issue.severity === 'warning') warnings++;
    else info++;
  }
  return {
    valid: errors === 0,
    specPath,
    summary: {
      errors,
      warnings,
      info,
      totalIssues: issues.length,
      truncated,
    },
    issues,
  };
}
