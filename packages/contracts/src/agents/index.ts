export {
  GENRE_CATALOG,
  GENRE_SLUGS,
  GENRE_LABELS,
  GENRE_GROUPS,
  GenreSlugSchema,
  GenreValueSchema,
  genreLabel,
  isKnownGenre,
  type GenreDef,
} from '../genres.js';

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
} from './llm-client.js';

export {
  MarketerThemeInputSchema,
  ThemeCandidateSchema,
  ThemeCompetitorSchema,
  ThemeSignalsSchema,
  MarketerThemeOutputSchema,
  MarketerMetadataInputSchema,
  KdpMetadataSchema,
  MarketerMetadataOutputSchema,
  MarketerPlanInputSchema,
  PlanMonthSchema,
  MarketerPlanOutputSchema,
  type MarketerThemeInput,
  type ThemeCandidate,
  type ThemeCompetitor,
  type ThemeSignals,
  type MarketerThemeOutput,
  type MarketerMetadataInput,
  type KdpMetadata,
  type MarketerMetadataOutput,
  type MarketerPlanInput,
  type PlanMonth,
  type MarketerPlanOutput,
} from './marketer.js';

export {
  WriterOutlineInputSchema,
  ChapterPlanSchema,
  WriterOutlineOutputSchema,
  WriterChapterInputSchema,
  WriterChapterOutputSchema,
  RevisionFeedbackItemSchema,
  type WriterOutlineInput,
  type ChapterPlan,
  type WriterOutlineOutput,
  type WriterChapterInput,
  type WriterChapterOutput,
  type RevisionFeedbackItem,
} from './writer.js';

export {
  EditorChapterInputSchema,
  EditorInputSchema,
  EditorChapterOutputSchema,
  EditorOutputSchema,
  type EditorChapterInput,
  type EditorInput,
  type EditorChapterOutput,
  type EditorOutput,
} from './editor.js';

export {
  CoverTextProposalSchema,
  ThumbnailTextInputSchema,
  ThumbnailTextOutputSchema,
  ThumbnailImageInputSchema,
  ThumbnailImageOutputSchema,
  type CoverTextProposal,
  type ThumbnailTextInput,
  type ThumbnailTextOutput,
  type ThumbnailImageInput,
  type ThumbnailImageOutput,
} from './thumbnail.js';

export {
  JudgeChapterInputSchema,
  JudgeInputSchema,
  JudgeOutputSchema,
  type JudgeChapterInput,
  type JudgeInput,
  type JudgeOutput,
} from './judge.js';

export {
  OptimizerInputSchema,
  OptimizerOutputSchema,
  type OptimizerInput,
  type OptimizerOutput,
} from './optimizer.js';

export {
  SnsCatalogSnapshotSchema,
  SnsStrategistInputSchema,
  ContentPillarSchema,
  PostingCadenceSchema,
  HashtagStrategySchema,
  AccountStrategyProfileSchema,
  type SnsCatalogSnapshot,
  type SnsStrategistInput,
  type ContentPillar,
  type PostingCadence,
  type HashtagStrategy,
  type AccountStrategyProfile,
} from './sns-strategist.js';

export {
  ContentPillarSeedSchema,
  ContentCreatorInputSchema,
  ValuePostSchema,
  AccountContentOutputSchema,
  type ContentPillarSeed,
  type ContentCreatorInput,
  type ValuePost,
  type AccountContentOutput,
} from './content-creator.js';

export {
  OptimizerDraftSchema,
  OptimizerSignalsSchema,
  ContentOptimizerInputSchema,
  OptimizerRevisionSchema,
  ContentOptimizerOutputSchema,
  type OptimizerDraft,
  type OptimizerSignals,
  type ContentOptimizerInput,
  type OptimizerRevision,
  type ContentOptimizerOutput,
} from './content-optimizer.js';

export {
  PromoStrategistInputSchema,
  PromoPlaybookSchema,
  HookFormulaSchema,
  PromoStrategistOutputSchema,
  playbookToGuidance,
  type PromoStrategistInput,
  type PromoPlaybook,
  type PromoStrategistOutput,
} from './promo-strategist.js';

export {
  CostByRoleModelSchema,
  CurrentAssignmentSchema,
  CatalogPriceSchema,
  CostOptimizerInputSchema,
  ProposalActionSchema,
  CostProposalSchema,
  CostOptimizerOutputSchema,
  type CostByRoleModel,
  type CurrentAssignment,
  type CatalogPrice,
  type CostOptimizerInput,
  type ProposalAction,
  type CostProposal,
  type CostOptimizerOutput,
} from './cost-optimizer.js';

export {
  TikTokVideoInputSchema,
  ScriptBeatSchema,
  VideoScenarioSchema,
  VideoSceneSchema,
  VideoScriptSchema,
  StoryboardSceneSchema,
  StoryboardSchema,
  type TikTokVideoInput,
  type ScriptBeat,
  type VideoScenario,
  type VideoScene,
  type VideoScript,
  type StoryboardScene,
  type Storyboard,
} from './tiktok-video.js';
