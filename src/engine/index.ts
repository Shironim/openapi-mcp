export {
  DEFAULT_SPEC_CANDIDATES,
  clearSpecCache,
  deepFreeze,
  findOpenApiSpecFile,
  getSpecCacheStats,
  loadOpenApiSpec,
  resolveSafeSpecPath,
  type FileFingerprint,
  type LoadOpenApiSpecOptions,
  type LoadedOpenApiSpec,
} from './spec-loader.js';

export {
  HTTP_METHODS,
  buildEndpointIndex,
  searchEndpoints,
  type EndpointIndex,
  type EndpointSearchFilters,
  type EndpointSummaryItem,
} from './index-builder.js';

export {
  DEFAULT_IGNORED_DIRS,
  listWorkspaceSpecs,
  scanWorkspaceSpecs,
  type WorkspaceSpecCatalog,
} from './spec-catalog.js';

export {
  escapeJsonPointer,
  parseDocumentWithLocations,
  type ParsedDocumentWithLocations,
  type SourceLocation,
} from './source-map.js';

export {
  buildSchemaIndex,
  searchSchemas,
  type SchemaIndex,
  type SchemaSearchFilters,
  type SchemaSummaryItem,
  type SchemaUsageRef,
} from './schema-index.js';

export {
  DEFAULT_SANDBOX_TIMEOUT_MS,
  runSandboxQuery,
  validateSandboxCode,
  type SandboxMetadata,
  type SandboxQueryOptions,
  type SandboxQueryResult,
} from './query-sandbox.js';

export {
  generateOperationExamples,
  generateSchemaExample,
  getMergedOperation,
  type ExampleGeneratorOptions,
  type MergedOperationContract,
} from './example-generator.js';

export {
  diagnoseOpenApiSpec,
  type DiagnosticSeverity,
  type SpecDiagnosticIssue,
  type SpecDiagnosticsReport,
} from './spec-diagnostics.js';

export {
  diffOpenApiSpecs,
  type DiffClassification,
  type SpecDiffChange,
  type SpecDiffReport,
} from './spec-diff.js';

export {
  DEFAULT_MAX_BYTES,
  enforceByteBudget,
  type BudgetCheckResult,
  type BudgetExceededPayload,
  type BudgetExceededResult,
  type BudgetOkResult,
} from './budget.js';
