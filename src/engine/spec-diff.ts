import { HTTP_METHODS } from './index-builder.js';
import { isRecord } from './json.js';

export type DiffClassification = 'breaking' | 'non_breaking';

export interface SpecDiffChange {
  classification: DiffClassification;
  code: string;
  endpoint: string;
  location?: string;
  message: string;
}

export interface SpecDiffReport {
  baseSpec?: string;
  targetSpec?: string;
  hasBreakingChanges: boolean;
  summary: {
    breakingCount: number;
    nonBreakingCount: number;
    addedEndpoints: number;
    removedEndpoints: number;
    totalChanges: number;
    truncated: boolean;
  };
  breaking: SpecDiffChange[];
  nonBreaking: SpecDiffChange[];
}

const MAX_DIFF_CHANGES = 250;
const MAX_SCHEMA_DIFF_DEPTH = 6;

function normalizeType(schema: unknown): string {
  if (typeof schema === 'boolean') return schema ? 'any' : 'never';
  if (!isRecord(schema)) return 'unknown';
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) {
    return schema.type.filter((t): t is string => typeof t === 'string').sort().join('|') || 'unknown';
  }
  if (isRecord(schema.properties)) return 'object';
  if (schema.items !== undefined) return 'array';
  if (Array.isArray(schema.oneOf)) return 'oneOf';
  if (Array.isArray(schema.anyOf)) return 'anyOf';
  if (Array.isArray(schema.allOf)) return 'allOf';
  return 'unknown';
}

function mergeObjectShape(schema: unknown, depth = 0): {
  properties: Map<string, unknown>;
  required: Set<string>;
} {
  const properties = new Map<string, unknown>();
  const required = new Set<string>();
  if (depth > 4 || !isRecord(schema)) return { properties, required };

  if (isRecord(schema.properties)) {
    for (const [k, v] of Object.entries(schema.properties)) properties.set(k, v);
  }
  if (Array.isArray(schema.required)) {
    for (const r of schema.required) {
      if (typeof r === 'string') required.add(r);
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      const sub = mergeObjectShape(branch, depth + 1);
      for (const [k, v] of sub.properties) properties.set(k, v);
      for (const r of sub.required) required.add(r);
    }
  }
  return { properties, required };
}

function collectMergedParams(pathItem: Record<string, unknown>, op: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  const add = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (isRecord(item) && typeof item.name === 'string' && typeof item.in === 'string') {
        map.set(`${item.in}:${item.name}`, item);
      }
    }
  };
  add(pathItem.parameters);
  add(op.parameters);
  return map;
}

/**
 * Semantically compares two resolved OpenAPI specifications and classifies changes into
 * `breaking` vs `nonBreaking` using O(E + P + F) indexed lookups.
 */
export function diffOpenApiSpecs(
  baseSpec: Record<string, unknown>,
  targetSpec: Record<string, unknown>,
  labels?: { base?: string; target?: string }
): SpecDiffReport {
  const breaking: SpecDiffChange[] = [];
  const nonBreaking: SpecDiffChange[] = [];
  let addedEndpoints = 0;
  let removedEndpoints = 0;
  let truncated = false;

  const record = (change: SpecDiffChange) => {
    if (breaking.length + nonBreaking.length >= MAX_DIFF_CHANGES) {
      truncated = true;
      return;
    }
    if (change.classification === 'breaking') breaking.push(change);
    else nonBreaking.push(change);
  };

  function diffSchemas(
    baseSchema: unknown,
    targetSchema: unknown,
    direction: 'request' | 'response',
    endpoint: string,
    loc: string,
    depth: number
  ): void {
    if (depth > MAX_SCHEMA_DIFF_DEPTH) return;
    if (typeof baseSchema === 'string' && baseSchema.startsWith('[Circular:')) return;
    if (typeof targetSchema === 'string' && targetSchema.startsWith('[Circular:')) return;

    const baseType = normalizeType(baseSchema);
    const targetType = normalizeType(targetSchema);
    if (baseType !== 'unknown' && targetType !== 'unknown' && baseType !== targetType) {
      record({
        classification: 'breaking',
        code: direction === 'request' ? 'REQUEST_TYPE_CHANGED' : 'RESPONSE_TYPE_CHANGED',
        endpoint,
        location: loc,
        message: `${direction} schema type at '${loc}' changed from '${baseType}' to '${targetType}'.`,
      });
      return;
    }

    if (isRecord(baseSchema) && isRecord(targetSchema)) {
      // Enum changes
      if (Array.isArray(baseSchema.enum) && Array.isArray(targetSchema.enum)) {
        const baseEnums = new Set(baseSchema.enum.map((v) => JSON.stringify(v)));
        const targetEnums = new Set(targetSchema.enum.map((v) => JSON.stringify(v)));
        if (direction === 'request') {
          for (const val of baseEnums) {
            if (!targetEnums.has(val)) {
              record({
                classification: 'breaking',
                code: 'REQUEST_ENUM_VALUE_REMOVED',
                endpoint,
                location: loc,
                message: `Request enum value ${val} removed at '${loc}'.`,
              });
            }
          }
        } else {
          for (const val of targetEnums) {
            if (!baseEnums.has(val)) {
              record({
                classification: 'breaking',
                code: 'RESPONSE_ENUM_VALUE_ADDED',
                endpoint,
                location: loc,
                message: `Response enum value ${val} added at '${loc}'.`,
              });
            }
          }
        }
      }

      // Array items
      if (baseType === 'array' && targetType === 'array' && baseSchema.items !== undefined && targetSchema.items !== undefined) {
        diffSchemas(baseSchema.items, targetSchema.items, direction, endpoint, `${loc}[]`, depth + 1);
      }

      // Object properties & required fields
      const baseShape = mergeObjectShape(baseSchema);
      const targetShape = mergeObjectShape(targetSchema);
      if (baseShape.properties.size > 0 || targetShape.properties.size > 0) {
        for (const [prop, basePropSchema] of baseShape.properties) {
          const propLoc = `${loc}.${prop}`;
          if (!targetShape.properties.has(prop)) {
            record({
              classification: 'breaking',
              code: direction === 'request' ? 'REQUEST_PROPERTY_REMOVED' : 'RESPONSE_PROPERTY_REMOVED',
              endpoint,
              location: propLoc,
              message: `${direction} property '${prop}' removed at '${propLoc}'.`,
            });
            continue;
          }
          const wasReq = baseShape.required.has(prop);
          const isReq = targetShape.required.has(prop);
          if (direction === 'request' && !wasReq && isReq) {
            record({
              classification: 'breaking',
              code: 'REQUEST_PROPERTY_BECAME_REQUIRED',
              endpoint,
              location: propLoc,
              message: `Request property '${prop}' changed from optional to required.`,
            });
          } else if (direction === 'response' && wasReq && !isReq) {
            record({
              classification: 'breaking',
              code: 'RESPONSE_PROPERTY_BECAME_OPTIONAL',
              endpoint,
              location: propLoc,
              message: `Response property '${prop}' changed from required to optional.`,
            });
          }
          diffSchemas(basePropSchema, targetShape.properties.get(prop), direction, endpoint, propLoc, depth + 1);
        }

        for (const prop of targetShape.properties.keys()) {
          if (baseShape.properties.has(prop)) continue;
          const propLoc = `${loc}.${prop}`;
          const isReq = targetShape.required.has(prop);
          if (direction === 'request' && isReq) {
            record({
              classification: 'breaking',
              code: 'REQUEST_REQUIRED_PROPERTY_ADDED',
              endpoint,
              location: propLoc,
              message: `New required request property '${prop}' added.`,
            });
          } else {
            record({
              classification: 'non_breaking',
              code: direction === 'request' ? 'REQUEST_OPTIONAL_PROPERTY_ADDED' : 'RESPONSE_PROPERTY_ADDED',
              endpoint,
              location: propLoc,
              message: `New ${direction} property '${prop}' added.`,
            });
          }
        }
      }
    }
  }

  const indexOperations = (spec: Record<string, unknown>) => {
    const ops = new Map<string, { pathItem: Record<string, unknown>; op: Record<string, unknown> }>();
    const paths = isRecord(spec.paths) ? spec.paths : {};
    for (const [pathKey, pathItem] of Object.entries(paths)) {
      if (!isRecord(pathItem)) continue;
      for (const method of HTTP_METHODS) {
        const op = pathItem[method];
        if (!isRecord(op)) continue;
        ops.set(`${method.toUpperCase()} ${pathKey}`, { pathItem, op });
      }
    }
    return ops;
  };

  const baseOps = indexOperations(baseSpec);
  const targetOps = indexOperations(targetSpec);

  for (const [endpoint, baseEntry] of baseOps) {
    const targetEntry = targetOps.get(endpoint);
    if (!targetEntry) {
      removedEndpoints++;
      record({
        classification: 'breaking',
        code: 'ENDPOINT_REMOVED',
        endpoint,
        message: `Endpoint ${endpoint} was removed.`,
      });
      continue;
    }

    if (baseEntry.op.deprecated !== true && targetEntry.op.deprecated === true) {
      record({
        classification: 'non_breaking',
        code: 'ENDPOINT_DEPRECATED',
        endpoint,
        message: `Endpoint ${endpoint} was marked deprecated.`,
      });
    }

    // Parameters
    const baseParams = collectMergedParams(baseEntry.pathItem, baseEntry.op);
    const targetParams = collectMergedParams(targetEntry.pathItem, targetEntry.op);

    for (const [key, baseParam] of baseParams) {
      const targetParam = targetParams.get(key);
      if (!targetParam) {
        record({
          classification: 'breaking',
          code: 'PARAMETER_REMOVED',
          endpoint,
          location: `parameters.${key}`,
          message: `Parameter '${key}' was removed.`,
        });
        continue;
      }
      if (baseParam.required !== true && targetParam.required === true) {
        record({
          classification: 'breaking',
          code: 'PARAMETER_BECAME_REQUIRED',
          endpoint,
          location: `parameters.${key}`,
          message: `Parameter '${key}' became required.`,
        });
      }
      if (baseParam.schema !== undefined && targetParam.schema !== undefined) {
        diffSchemas(baseParam.schema, targetParam.schema, 'request', endpoint, `parameters.${key}`, 0);
      }
    }
    for (const [key, targetParam] of targetParams) {
      if (baseParams.has(key)) continue;
      if (targetParam.required === true) {
        record({
          classification: 'breaking',
          code: 'REQUIRED_PARAMETER_ADDED',
          endpoint,
          location: `parameters.${key}`,
          message: `New required parameter '${key}' was added.`,
        });
      } else {
        record({
          classification: 'non_breaking',
          code: 'OPTIONAL_PARAMETER_ADDED',
          endpoint,
          location: `parameters.${key}`,
          message: `New optional parameter '${key}' was added.`,
        });
      }
    }

    // RequestBody
    const baseReq = isRecord(baseEntry.op.requestBody) ? baseEntry.op.requestBody : undefined;
    const targetReq = isRecord(targetEntry.op.requestBody) ? targetEntry.op.requestBody : undefined;
    if (baseReq?.required !== true && targetReq?.required === true) {
      record({
        classification: 'breaking',
        code: 'REQUEST_BODY_BECAME_REQUIRED',
        endpoint,
        location: 'requestBody',
        message: 'Request body became required.',
      });
    }
    const baseReqContent = isRecord(baseReq?.content) ? baseReq.content : {};
    const targetReqContent = isRecord(targetReq?.content) ? targetReq.content : {};
    for (const [mediaType, baseMedia] of Object.entries(baseReqContent)) {
      const targetMedia = targetReqContent[mediaType];
      if (!isRecord(targetMedia)) {
        record({
          classification: 'breaking',
          code: 'REQUEST_MEDIA_TYPE_REMOVED',
          endpoint,
          location: `requestBody.${mediaType}`,
          message: `Request media type '${mediaType}' was removed.`,
        });
        continue;
      }
      if (isRecord(baseMedia) && baseMedia.schema !== undefined && targetMedia.schema !== undefined) {
        diffSchemas(baseMedia.schema, targetMedia.schema, 'request', endpoint, `requestBody.${mediaType}`, 0);
      }
    }
    for (const mediaType of Object.keys(targetReqContent)) {
      if (!(mediaType in baseReqContent)) {
        record({
          classification: 'non_breaking',
          code: 'REQUEST_MEDIA_TYPE_ADDED',
          endpoint,
          location: `requestBody.${mediaType}`,
          message: `Request media type '${mediaType}' was added.`,
        });
      }
    }

    // Responses
    const baseResps = isRecord(baseEntry.op.responses) ? baseEntry.op.responses : {};
    const targetResps = isRecord(targetEntry.op.responses) ? targetEntry.op.responses : {};
    for (const [status, baseResp] of Object.entries(baseResps)) {
      const targetResp = targetResps[status];
      if (!isRecord(targetResp)) {
        record({
          classification: 'breaking',
          code: 'RESPONSE_STATUS_REMOVED',
          endpoint,
          location: `responses.${status}`,
          message: `Response status '${status}' was removed.`,
        });
        continue;
      }
      const baseContent = isRecord(baseResp) && isRecord(baseResp.content) ? baseResp.content : {};
      const targetContent = isRecord(targetResp.content) ? targetResp.content : {};
      for (const [mediaType, baseMedia] of Object.entries(baseContent)) {
        const targetMedia = targetContent[mediaType];
        if (!isRecord(targetMedia)) {
          record({
            classification: 'breaking',
            code: 'RESPONSE_MEDIA_TYPE_REMOVED',
            endpoint,
            location: `responses.${status}.${mediaType}`,
            message: `Response media type '${mediaType}' for status '${status}' was removed.`,
          });
          continue;
        }
        if (isRecord(baseMedia) && baseMedia.schema !== undefined && targetMedia.schema !== undefined) {
          diffSchemas(baseMedia.schema, targetMedia.schema, 'response', endpoint, `responses.${status}.${mediaType}`, 0);
        }
      }
    }
    for (const status of Object.keys(targetResps)) {
      if (!(status in baseResps)) {
        record({
          classification: 'non_breaking',
          code: 'RESPONSE_STATUS_ADDED',
          endpoint,
          location: `responses.${status}`,
          message: `Response status '${status}' was added.`,
        });
      }
    }
  }

  for (const endpoint of targetOps.keys()) {
    if (!baseOps.has(endpoint)) {
      addedEndpoints++;
      record({
        classification: 'non_breaking',
        code: 'ENDPOINT_ADDED',
        endpoint,
        message: `Endpoint ${endpoint} was added.`,
      });
    }
  }

  return {
    ...(labels?.base ? { baseSpec: labels.base } : {}),
    ...(labels?.target ? { targetSpec: labels.target } : {}),
    hasBreakingChanges: breaking.length > 0,
    summary: {
      breakingCount: breaking.length,
      nonBreakingCount: nonBreaking.length,
      addedEndpoints,
      removedEndpoints,
      totalChanges: breaking.length + nonBreaking.length,
      truncated,
    },
    breaking,
    nonBreaking,
  };
}
