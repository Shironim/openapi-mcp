import { LineCounter, isMap, isPair, isScalar, parseDocument, type Node as YamlNode } from 'yaml';

export interface SourceLocation {
  file: string;
  line: number;
  col: number;
}

export interface ParsedDocumentWithLocations {
  value: unknown;
  locations: Map<string, SourceLocation>;
}

export function escapeJsonPointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function collectMapLocations(
  node: YamlNode | null | undefined,
  prefix: string,
  depth: number,
  maxDepth: number,
  file: string,
  lineCounter: LineCounter,
  out: Map<string, SourceLocation>
): void {
  if (!node || depth > maxDepth || !isMap(node)) return;
  for (const item of node.items) {
    if (!isPair(item) || !isScalar(item.key)) continue;
    const rawKey = item.key.value;
    if (typeof rawKey !== 'string' && typeof rawKey !== 'number') continue;
    const key = String(rawKey);
    const pointer = `${prefix}/${escapeJsonPointer(key)}`;
    const rangeStart = item.key.range?.[0] ?? (item.value as YamlNode | null | undefined)?.range?.[0];
    if (typeof rangeStart === 'number') {
      const pos = lineCounter.linePos(rangeStart);
      out.set(pointer, { file, line: pos.line, col: pos.col });
    }
    if (depth < maxDepth && item.value && isMap(item.value)) {
      // Only descend into structural OpenAPI containers to keep map size O(E + S).
      const shouldDescend =
        depth === 0
          ? key === 'paths' || key === 'components' || key === 'definitions'
          : depth === 1
            ? prefix === '/paths' || prefix === '/components'
            : false;
      if (shouldDescend) {
        collectMapLocations(item.value, pointer, depth + 1, maxDepth, file, lineCounter, out);
      }
    }
  }
}

/**
 * Parses YAML/JSON once using `yaml` v2 `parseDocument` + `LineCounter` to produce both
 * the JS value and 1-based `{ file, line, col }` source locations for endpoints and components.
 */
export function parseDocumentWithLocations(
  content: string,
  relativeFile: string
): ParsedDocumentWithLocations {
  const lineCounter = new LineCounter();
  const doc = parseDocument(content, { lineCounter, prettyErrors: true });
  if (doc.errors.length > 0) {
    throw doc.errors[0]!;
  }
  const locations = new Map<string, SourceLocation>();
  collectMapLocations(doc.contents, '', 0, 2, relativeFile, lineCounter, locations);
  return {
    value: doc.toJS(),
    locations,
  };
}
