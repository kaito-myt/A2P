/**
 * Writer エージェント — `packages/agents` 外部公開エントリ。
 * T-04-01: アウトライン生成 (outline.ts)。
 * T-04-02: 章執筆 (chapter.ts)。
 */
export {
  generateOutline,
  type GenerateOutlineDeps,
} from './outline.js';

export {
  generateChapter,
  type GenerateChapterDeps,
} from './chapter.js';
