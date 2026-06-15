/**
 * docs/05 §6.1 — LLM クライアント二層構造の統一インターフェース。
 * 真の型定義は `@a2p/contracts/agents` 側にある (workspace 構造上、契約型は contracts に集約)。
 * このファイルはローカル互換性のための re-export。
 */
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
} from '@a2p/contracts/agents';
