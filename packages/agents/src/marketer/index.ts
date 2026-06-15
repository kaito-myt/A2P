/**
 * Marketer エージェント — `packages/agents` 外部公開エントリ。
 * T-03-01: テーマ生成 (theme.ts) / T-03-02: KDP メタデータ生成 (metadata.ts) / T-08-01: 長期プラン (plan.ts)。
 */
export {
  generateMarketerThemes,
  type GenerateThemesDeps,
} from './theme.js';
export {
  generateMarketerMetadata,
  type GenerateMetadataDeps,
} from './metadata.js';
export {
  generatePlan,
  type GeneratePlanDeps,
} from './plan.js';
