/**
 * Anypoint Connect — Library Barrel Export
 */

// Client
export { AnypointClient, type AnypointClientConfig } from './client/AnypointClient.js';

// Auth
export { TokenManager, type TokenManagerConfig, type AuthStatus } from './auth/TokenManager.js';
export { OAuthFlow, type OAuthConfig, type OAuthCallbackOptions } from './auth/OAuthFlow.js';
export { FileStore } from './auth/FileStore.js';
export type { TokenStore, AnypointTokens } from './auth/TokenStore.js';

// APIs
export {
    AccessManagementApi,
    type UserProfile,
    type Environment,
    type OrgEntitlements,
    type OrgSubscription,
    type OrgDetails,
} from './api/AccessManagementApi.js';
export {
    CloudHub2Api,
    type CH2Deployment,
    type CH2DeploymentSummary,
    type CH2DeploymentSpec,
    type CH2Replica,
    type CreateDeploymentPayload,
    type ArtifactRef,
    type ApplicationPropertiesService,
    type ApplicationConfigurationUpdate,
    type DeploymentDeletionVerification,
    type DeploymentPatch,
} from './api/CloudHub2Api.js';
export { LogsApi, type LogEntry } from './api/LogsApi.js';
export {
    MonitoringApi,
    AMQL_MAX_LIMIT,
    GRANULARITY,
    GRANULARITIES,
    TIME_SERIES_SIGNALS,
    isGranularity,
    amqlString,
    type Granularity,
    type MetricRow,
    type MetricsScope,
    type MetricsGroupBy,
    type MetricsExport,
    type TrafficMetrics,
    type RouteMetrics,
    type RuntimeMetrics,
    type MemoryPoolMetrics,
    type GcCollectorMetrics,
    type TimeSeriesSignal,
    type TimeSeriesPoint,
} from './api/MonitoringApi.js';
export { ExchangeApi, type ExchangeAsset, type ExchangeAssetDetail } from './api/ExchangeApi.js';
export { ApiManagerApi, type ApiInstance, type ApiAsset, type ApiPolicy, type SlaTier } from './api/ApiManagerApi.js';
export {
    DesignCenterApi,
    type DesignCenterProject,
    type DesignCenterFile,
    type DesignCenterBranch,
    type DesignCenterSaveFile,
    type PublishToExchangeOptions,
} from './api/DesignCenterApi.js';
export { DesignCenterWorkflow, type DesignCenterFileInput, type SyncPlanEntry } from './workflows/design-center.js';
export {
    GovernanceApi,
    type GovernanceAssetCoordinates,
    type GovernanceConformanceRequest,
} from './api/GovernanceApi.js';

export {
    AuditLogApi,
    type AuditLogEntry,
    type AuditLogObject,
    type AuditLogResponse,
    type AuditLogQuery,
} from './api/AuditLogApi.js';
export { AnypointMQApi, type MQDestination, type MQStats, type MQMessage } from './api/AnypointMQApi.js';
export {
    ObjectStoreApi,
    type ObjectStore,
    type ObjectStoreKeysPage,
    type ObjectStoreValue,
} from './api/ObjectStoreApi.js';

export { RuntimesApi, type RuntimeVersion, type RuntimeTarget } from './api/RuntimesApi.js';

// Application changes
export {
    planAppChange,
    describeAppChange,
    executeAppChange,
    resolveSettingsInput,
    type AppChangeRequest,
    type AppChangePlan,
    type AppChangeResult,
    type ChangeMode,
    type UpdateStrategy,
    type SettingsChangeInput,
    type RuntimeCheck,
} from './workflows/app-change.js';
export {
    deploymentPhase,
    waitForAppPhase,
    type AppPhase,
    type PhaseSnapshot,
    type WaitOptions,
    type WaitResult,
} from './workflows/app-state.js';
export {
    suggestAssetCoordinates,
    inferConvention,
    type AssetConvention,
    type AssetSuggestion,
} from './workflows/asset-naming.js';
export {
    planSettingsChange,
    currentSettings,
    type SettingsChange,
    type SettingsDiff,
    type SettingsPlan,
} from './safety/deployment.js';
export { resolveRuntime, suggestRuntimes, parseRuntimeString, type RuntimeSpec } from './safety/runtime.js';
export { looksSecret, redactValue, redactRecord, redactText, MASKED } from './safety/secrets.js';
export { resolveSecretSource, resolveSecretSources, type SecretSource } from './safety/secret-sources.js';

// Utils
export { AmqlQueryError, errorMessage } from './utils/errors.js';
export { HttpClient, type HttpClientConfig } from './client/HttpClient.js';
export { Cache, type CacheStats } from './client/Cache.js';
export { RateLimiter, type RateLimiterConfig } from './client/RateLimiter.js';
