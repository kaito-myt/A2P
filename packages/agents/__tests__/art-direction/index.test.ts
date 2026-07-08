/**
 * cover_art_direction エージェントの単体テスト。
 * AgentSdkClient (web_search) 経由のためテキスト応答 → JSON 抽出 → zod 検証する経路を検証。
 */
import { describe, expect, it, vi } from 'vitest';

import { generateCoverArtDirection } from '../../src/art-direction/index.js';
import type { CoverArtDirectionInput } from '@a2p/contracts/agents/thumbnail';

function input(): CoverArtDirectionInput {
  return {
    jobId: 'job-1',
    bookId: 'book-1',
    genre: 'business',
    themeContext: {
      title: '副業で月5万円',
      hook: '忙しい会社員でもできる',
      target_reader: '30代会社員',
    },
    count: 3,
  };
}

function stubDeps(responseText: string) {
  const complete = vi.fn(async () => ({ text: responseText }));
  return {
    loadActivePrompt: vi.fn(async () => ({
      id: 'p1',
      version: 1,
      template: 'SYSTEM PROMPT {{genre}} {{count}}',
    })) as never,
    createAgentClient: vi.fn(async () => ({ complete })) as never,
    _complete: complete,
  };
}

const VALID = {
  directions: [
    { concept: '売れ筋は写真的が多い。信頼感を出す。', image_prompt: 'A photographic desk scene', style_label: '写真的' },
    { concept: '差別化でイラスト。', image_prompt: 'A friendly flat illustration', style_label: 'イラスト' },
    { concept: 'タイポ主体。', image_prompt: 'Bold minimal geometric shapes', style_label: 'ミニマル' },
  ],
};

describe('generateCoverArtDirection', () => {
  it('プレーン JSON テキストをパースして directions を返す', async () => {
    const deps = stubDeps(JSON.stringify(VALID));
    const out = await generateCoverArtDirection(input(), deps);
    expect(out.directions).toHaveLength(3);
    expect(out.directions[0]!.style_label).toBe('写真的');
  });

  it('```json フェンス + 前後の散文を含む応答から JSON を抽出する', async () => {
    const text = `調査しました。以下が提案です。\n\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\`\n以上です。`;
    const deps = stubDeps(text);
    const out = await generateCoverArtDirection(input(), deps);
    expect(out.directions).toHaveLength(3);
  });

  it('文字列値内の生改行を含んでもパースできる', async () => {
    const withNewline = `{"directions":[{"concept":"1行目\n2行目","image_prompt":"a scene"},{"concept":"b","image_prompt":"c"},{"concept":"d","image_prompt":"e"}]}`;
    const deps = stubDeps(withNewline);
    const out = await generateCoverArtDirection(input(), deps);
    expect(out.directions[0]!.concept).toContain('2行目');
  });

  it('JSON が全く無ければ AgentError を投げる', async () => {
    const deps = stubDeps('すみません、うまく生成できませんでした。');
    await expect(generateCoverArtDirection(input(), deps)).rejects.toThrow();
  });

  it('スキーマ不一致 (directions 不足) は AgentError', async () => {
    const deps = stubDeps(JSON.stringify({ directions: [] }));
    await expect(generateCoverArtDirection(input(), deps)).rejects.toThrow();
  });

  it('system プロンプトに genre/count が展開され、responseSchema は渡さない', async () => {
    const deps = stubDeps(JSON.stringify(VALID));
    await generateCoverArtDirection(input(), deps);
    const arg = deps._complete.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.responseSchema).toBeUndefined();
    const sys = (arg.messages as Array<{ role: string; content: string }>)[0]!.content;
    expect(sys).toContain('business');
    expect(sys).toContain('3');
  });
});
