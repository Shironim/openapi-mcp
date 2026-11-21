import { isRecord } from './json.js';

export const DEFAULT_MAX_BYTES = 16 * 1024;
export const MAX_RESULT_BYTES = 1024 * 1024;

export interface BudgetOkResult {
  ok: true;
  truncated: false;
  byteLength: number;
  maxBytes: number;
  text: string;
  data: unknown;
}

export interface BudgetExceededPayload {
  error: 'RESPONSE_BUDGET_EXCEEDED';
  truncated: true;
  byteLength: number;
  maxBytes: number;
  summary: {
    resultType: 'array' | 'object' | 'string' | 'primitive';
    itemCount?: number;
    availableKeys?: string[];
    totalKeys?: number;
    preview: string;
  };
  hint: string;
  examples: string[];
}

export interface BudgetExceededResult {
  ok: false;
  truncated: true;
  byteLength: number;
  maxBytes: number;
  text: string;
  errorPayload: BudgetExceededPayload;
}

export type BudgetCheckResult = BudgetOkResult | BudgetExceededResult;

function buildPreviewSnippet(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.slice(0, maxChars).split('\n');
  if (lines.length > 1) {
    lines.pop();
    return `${lines.join('\n')}\n... [truncated preview]`;
  }
  return `${text.slice(0, maxChars)}... [truncated]`;
}

/**
 * Enforces a strict UTF-8 byte budget on serialized query results.
 * When exceeded, returns a compact diagnostic payload with available keys and actionable narrowing hints.
 */
export function enforceByteBudget(data: unknown, maxBytes = DEFAULT_MAX_BYTES): BudgetCheckResult {
  const normalized = data === undefined ? null : data;
  return enforceSerializedByteBudget(normalized, JSON.stringify(normalized, null, 2) ?? 'null', maxBytes);
}

export function enforceSerializedByteBudget(
  normalized: unknown,
  jsonText: string,
  maxBytes = DEFAULT_MAX_BYTES
): BudgetCheckResult {
  const effectiveMaxBytes =
    typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
      ? Math.min(MAX_RESULT_BYTES, Math.max(1, Math.floor(maxBytes)))
      : DEFAULT_MAX_BYTES;

  const byteLength = Buffer.byteLength(jsonText, 'utf8');

  if (byteLength <= effectiveMaxBytes) {
    return {
      ok: true,
      truncated: false,
      byteLength,
      maxBytes: effectiveMaxBytes,
      text: jsonText,
      data: normalized,
    };
  }

  let summary: BudgetExceededPayload['summary'];
  const previewCap = Math.min(600, Math.max(120, Math.floor(effectiveMaxBytes / 4)));

  if (Array.isArray(normalized)) {
    const firstObjKeys =
      isRecord(normalized[0])
        ? Object.keys(normalized[0]).slice(0, 20).map((key) => key.slice(0, 80))
        : undefined;
    summary = {
      resultType: 'array',
      itemCount: normalized.length,
      ...(firstObjKeys ? { availableKeys: firstObjKeys } : {}),
      preview: buildPreviewSnippet(jsonText, previewCap),
    };
  } else if (isRecord(normalized)) {
    const keys = Object.keys(normalized);
    summary = {
      resultType: 'object',
      totalKeys: keys.length,
      availableKeys: keys.slice(0, 30).map((key) => key.slice(0, 80)),
      preview: buildPreviewSnippet(jsonText, previewCap),
    };
  } else if (typeof normalized === 'string') {
    summary = {
      resultType: 'string',
      preview: buildPreviewSnippet(normalized, previewCap),
    };
  } else {
    summary = {
      resultType: 'primitive',
      preview: buildPreviewSnippet(jsonText, previewCap),
    };
  }

  const keySuggestion =
    summary.availableKeys && summary.availableKeys.length > 0
      ? ` Available keys include: ${summary.availableKeys.slice(0, 8).join(', ')}.`
      : '';

  const errorPayload: BudgetExceededPayload = {
    error: 'RESPONSE_BUDGET_EXCEEDED',
    truncated: true,
    byteLength,
    maxBytes: effectiveMaxBytes,
    summary,
    hint:
      `Query output (${byteLength} bytes) exceeds the ${effectiveMaxBytes}-byte response budget.${keySuggestion} ` +
      `Narrow your openapi_query to a specific path, HTTP method, response status code, or schema—or pass a larger max_bytes.`,
    examples: [
      "Object.keys(spec.paths ?? {})",
      "spec.paths['/users']?.get?.responses",
      "Object.keys(spec.components?.schemas ?? {})",
    ],
  };

  return {
    ok: false,
    truncated: true,
    byteLength,
    maxBytes: effectiveMaxBytes,
    text: JSON.stringify(errorPayload, null, 2),
    errorPayload,
  };
}
