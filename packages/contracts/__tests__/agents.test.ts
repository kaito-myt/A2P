import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  AgentRole,
  Genre,
  LLMClient,
  LLMCompleteArgs,
  LLMCompleteResult,
  LLMStreamChunk,
  LLMUsage,
  Provider,
} from '../src/agents/index.js';

/**
 * T-02-01 §4 受け入れ基準: `@a2p/contracts/agents` サブパス経由で
 * `LLMClient` interface を含む全 9 型が公開されていることを検証する。
 * `@a2p/contracts` ルート (`.`) からは agents 型が見えてはならない。
 *
 * テスト内では相対 import を使う (workspace 自己参照を回避)。
 * subpath 公開の実体性は `packages/agents` 側の re-export と
 * `packages/contracts/package.json` の `exports."./agents"` で担保される。
 */

describe('@a2p/contracts/agents subpath export', () => {
  it('AgentRole / Genre / Provider のリテラル集合が docs/05 と一致する', () => {
    const roles: AgentRole[] = [
      'marketer',
      'writer',
      'editor',
      'judge',
      'thumbnail_text',
      'thumbnail_image',
      'optimizer',
      'revision',
    ];
    const genres: Genre[] = ['practical', 'business', 'self_help'];
    const providers: Provider[] = ['anthropic', 'openai', 'google', 'tavily'];
    expect(roles).toHaveLength(8);
    expect(genres).toHaveLength(3);
    expect(providers).toHaveLength(4);
  });

  it('LLMCompleteArgs / LLMCompleteResult / LLMUsage / LLMStreamChunk の構造が import 可能', () => {
    const usage: LLMUsage = { inputTokens: 1, outputTokens: 2 };
    const args: LLMCompleteArgs = {
      role: 'writer',
      messages: [{ role: 'user', content: 'x' }],
    };
    const result: LLMCompleteResult = {
      text: 'ok',
      usage,
      costJpy: 0,
      provider: 'anthropic',
      model: 'noop',
    };
    const chunk: LLMStreamChunk = { delta: 'd' };
    expect(args.role).toBe('writer');
    expect(result.text).toBe('ok');
    expect(chunk.delta).toBe('d');
  });

  it('LLMClient interface を最小実装で satisfy できる', () => {
    class Fake implements LLMClient {
      async complete<T = string>(_args: LLMCompleteArgs): Promise<LLMCompleteResult<T>> {
        return {
          text: '' as T,
          usage: { inputTokens: 0, outputTokens: 0 },
          costJpy: 0,
          provider: 'anthropic',
          model: 'noop',
        };
      }
      async *stream(_args: LLMCompleteArgs): AsyncIterable<LLMStreamChunk> {
        yield { delta: '' };
      }
    }
    const c: LLMClient = new Fake();
    expectTypeOf(c.complete).toBeFunction();
    expectTypeOf(c.stream).toBeFunction();
  });

  it('ルート src/index.ts には agents 型を含めない (サブパス経由のみ)', async () => {
    // 動的 import でルートエクスポート集合を検証。agents 関連の値 export が無いこと
    // (型 export は実行時には消えるため、値の不在 = 適切な切り分けの間接的検証)。
    const root: Record<string, unknown> = await import('../src/index.js');
    const keys = Object.keys(root);
    expect(keys).not.toContain('LLMClient');
    expect(keys).not.toContain('AgentRole');
  });
});
