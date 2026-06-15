/**
 * docs/05 §6.1.2 — `createAgentClient(role, genre, ctx)` のみが LLMClient の
 * 唯一の生成口。CI ガード (T-02-12) でこのファクトリ以外での `new AISdkClient` /
 * `new AgentSdkClient` を禁止することで、トークン記録漏れを構造的に防ぐ。
 *
 * 分岐:
 *  - role='marketer' かつ provider='anthropic' → `AgentSdkClient` (web_search server tool)
 *  - それ以外 → `AISdkClient` (Vercel AI SDK)
 *
 * 返却値は常に `withTokenLogging` でラップ済み。
 */
import { ConfigError } from '@a2p/contracts/errors';
import type { AgentRole, Genre, LLMClient } from '@a2p/contracts/agents';

import { AISdkClient } from './ai-sdk-client.js';
import { AgentSdkClient } from './agent-sdk-client.js';
import { getApiKey, type ApiKeyProvider } from './get-api-key.js';
import {
  loadModelAssignment,
  type LoadModelAssignmentDeps,
} from './load-model-assignment.js';
import {
  withTokenLogging,
  type LoggingContext,
  type WithTokenLoggingDeps,
} from './with-token-logging.js';

export interface CreateAgentClientDeps {
  loadAssignment?: typeof loadModelAssignment;
  getApiKey?: typeof getApiKey;
  /** withTokenLogging に注入する deps (テストで Prisma を差し替える経路)。 */
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  /** loadModelAssignment に注入する deps (テストで Prisma を差し替える経路)。 */
  loadAssignmentDeps?: LoadModelAssignmentDeps;
}

const SUPPORTED_PROVIDERS = new Set<string>(['anthropic', 'openai', 'google']);

function assertSupportedProvider(provider: string): asserts provider is ApiKeyProvider {
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new ConfigError(
      `unsupported provider in ModelAssignment: ${provider} (expected anthropic|openai|google)`,
    );
  }
}

export async function createAgentClient(
  role: AgentRole,
  genre: Genre | null,
  ctx: LoggingContext,
  deps: CreateAgentClientDeps = {},
): Promise<LLMClient> {
  const load = deps.loadAssignment ?? loadModelAssignment;
  const fetchKey = deps.getApiKey ?? getApiKey;

  const assignment = await load(role, genre, deps.loadAssignmentDeps);
  assertSupportedProvider(assignment.provider);

  const apiKey = await fetchKey(assignment.provider);

  const useAgentSdk = role === 'marketer' && assignment.provider === 'anthropic';
  const raw: LLMClient = useAgentSdk
    ? new AgentSdkClient({ model: assignment.model, apiKey })
    : new AISdkClient({
        provider: assignment.provider,
        model: assignment.model,
        apiKey,
      });

  return withTokenLogging(raw, ctx, deps.withTokenLoggingDeps);
}
