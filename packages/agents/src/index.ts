export type {
  AgentRole,
  Genre,
  LLMClient,
  LLMCompleteArgs,
  LLMCompleteResult,
  LLMStreamChunk,
  LLMTool,
  LLMUsage,
  Provider,
} from './lib/llm-client.js';

export { AISdkClient, type AISdkClientOptions } from './lib/ai-sdk-client.js';
export {
  AgentSdkClient,
  assertAnthropicProvider,
  type AgentSdkClientOptions,
} from './lib/agent-sdk-client.js';
export {
  classifyProviderError,
  isNonRetryable,
  type ClassifiedProviderError,
  type ProviderErrorKind,
} from './lib/errors.js';

export {
  getApiKey,
  invalidateApiKeyCache,
  type ApiKeyProvider,
} from './lib/get-api-key.js';

export {
  withTokenLogging,
  type LoggingContext,
  type WithTokenLoggingDeps,
} from './lib/with-token-logging.js';
export {
  updateBookCost,
  type UpdateBookCostPrisma,
} from './lib/update-book-cost.js';
export {
  loadModelAssignment,
  type LoadedAssignment,
  type LoadModelAssignmentDeps,
} from './lib/load-model-assignment.js';
export {
  createAgentClient,
  type CreateAgentClientDeps,
} from './lib/llm-client-factory.js';
export {
  loadActivePrompt,
  fillPlaceholders,
  type LoadedPrompt,
  type PromptLoaderDeps,
  type PromptLoaderLogger,
} from './lib/prompt-loader.js';

export {
  generateImage,
  type GenerateImageArgs,
  type GenerateImageResult,
  type GenerateImageFn,
  type ImageGenDeps,
  type ImageQuality,
  type OpenAIImagesClient,
} from './tools/image-gen.js';
export {
  withImageLogging,
  type ImageLoggingContext,
  type WithImageLoggingDeps,
} from './lib/with-image-logging.js';

export {
  acquireBookLock,
  releaseBookLock,
  sweepExpiredLocks,
  type AcquireBookLockArgs,
  type ReleaseBookLockArgs,
  type BookLockDeps,
  type BookLockLogger,
  type BookLockRecord,
  type BookLockRepo,
  type SweepResult,
} from './lib/book-lock.js';

export {
  generateMarketerThemes,
  type GenerateThemesDeps,
} from './marketer/theme.js';

export {
  generateOutline,
  type GenerateOutlineDeps,
} from './writer/outline.js';

export {
  editBook,
  type EditBookDeps,
} from './editor/index.js';

export {
  generateCoverText,
  type GenerateCoverTextDeps,
} from './thumbnail/text.js';

export {
  generateCoverImage,
  type GenerateCoverImageDeps,
} from './thumbnail/image.js';

export {
  verifyCoverText,
  type VerifyCoverTextDeps,
} from './thumbnail/text-check.js';

export {
  generateReadings,
  type GenerateReadingsDeps,
  type ReadingsResult,
} from './readings/index.js';

export {
  generateCoverArtDirection,
  type GenerateCoverArtDirectionDeps,
} from './art-direction/index.js';

export {
  reviewOutline,
  type ReviewOutlineDeps,
} from './writer/outline-review.js';

export {
  generatePromotionPlan,
  type GeneratePromotionDeps,
} from './promoter/index.js';

export {
  planObjective,
  buildCeoUserMessage,
  type CeoPlanInput,
  type CeoPlanDeps,
  type CompanySnapshot,
} from './org/ceo.js';

export {
  planDivisionTasks,
  buildManagerUserMessage,
  type ManagerPlanInput,
  type ManagerPlanDeps,
  type DivisionContext,
} from './org/manager.js';

export { kanaToRomaji } from './lib/kana-to-romaji.js';

export {
  judgeBook,
  type JudgeBookDeps,
} from './judge/index.js';

export {
  optimizePrompt,
  type OptimizerDeps,
} from './optimizer/index.js';

export {
  AnthropicNativeWebSearch,
  TavilyWebSearch,
  createWebSearchAdapter,
  WebSearchQuerySchema,
  WebSearchResultItemSchema,
  WebSearchResultSchema,
  type CreateWebSearchAdapterOptions,
  type TavilyWebSearchOptions,
  type WebSearchAdapter,
  type WebSearchProvider,
  type WebSearchQuery,
  type WebSearchResult,
  type WebSearchResultItem,
} from './tools/web-search.js';
