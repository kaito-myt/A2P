/**
 * verifyCoverText (F-007b) unit tests.
 *
 * judge と同じく createAgentClient / loadActivePrompt を DI で差し替え、
 * 実 API / DB を引かずに検証する。
 */
import { describe, it, expect, vi } from 'vitest';

import { verifyCoverText } from '../../src/thumbnail/text-check.js';
import type { CoverTextCheckInput, CoverTextCheckOutput } from '@a2p/contracts/agents/thumbnail';

function baseInput(overrides: Partial<CoverTextCheckInput> = {}): CoverTextCheckInput {
  return {
    bookId: overrides.bookId ?? 'book-1',
    genre: overrides.genre ?? null,
    title: overrides.title ?? '副業で月5万円稼ぐ方法',
    imageBase64: overrides.imageBase64 ?? Buffer.from('FAKE_JPEG').toString('base64'),
    mimeType: overrides.mimeType ?? 'image/jpeg',
    ...(overrides.subtitle !== undefined ? { subtitle: overrides.subtitle } : {}),
    ...(overrides.jobId !== undefined ? { jobId: overrides.jobId } : {}),
  };
}

const okVerdict: CoverTextCheckOutput = {
  ok: true,
  title_legible: true,
  title_matches: true,
  garbled_text_detected: false,
  extra_text_detected: false,
  transcribed_text: '副業で月5万円稼ぐ方法',
  issues: [],
  confidence: 0.95,
};

function makeDeps(verdict: CoverTextCheckOutput = okVerdict) {
  const complete = vi.fn(async (_args: unknown) => ({
    text: verdict,
    usage: { inputTokens: 100, outputTokens: 20 },
    costJpy: 0,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
  }));
  const createAgentClient = vi.fn(async () => ({ complete }) as never);
  const loadActivePrompt = vi.fn(async () => ({
    id: 'p1',
    role: 'cover_text_check',
    genre: null,
    version: 1,
    template: '# カバー文字チェック\n検証してください。',
  })) as never;
  return { createAgentClient, loadActivePrompt, complete };
}

describe('verifyCoverText', () => {
  it('passes image + intended title to the vision client and returns the verdict', async () => {
    const { createAgentClient, loadActivePrompt, complete } = makeDeps();

    const result = await verifyCoverText(baseInput(), {
      createAgentClient,
      loadActivePrompt,
    });

    expect(result.ok).toBe(true);
    expect(createAgentClient).toHaveBeenCalledWith(
      'cover_text_check',
      null,
      expect.objectContaining({ role: 'cover_text_check', bookId: 'book-1' }),
      expect.anything(),
    );

    // complete に画像つきユーザーメッセージと responseSchema が渡る。
    const completeArg = complete.mock.calls[0]![0] as unknown as {
      messages: Array<{ role: string; content: string; images?: Array<{ data: string; mimeType: string }> }>;
      responseSchema?: unknown;
    };
    expect(completeArg.responseSchema).toBeDefined();
    const userMsg = completeArg.messages.find((m) => m.role === 'user')!;
    expect(userMsg.images).toHaveLength(1);
    expect(userMsg.images![0]!.mimeType).toBe('image/jpeg');
    expect(userMsg.content).toContain('副業で月5万円稼ぐ方法');
  });

  it('returns a garbled verdict unchanged', async () => {
    const garbled: CoverTextCheckOutput = {
      ok: false,
      title_legible: false,
      title_matches: false,
      garbled_text_detected: true,
      extra_text_detected: false,
      transcribed_text: '副業で月5万円稼ぐ方珐',
      issues: ['「法」が崩れている'],
      confidence: 0.8,
    };
    const { createAgentClient, loadActivePrompt } = makeDeps(garbled);

    const result = await verifyCoverText(baseInput(), { createAgentClient, loadActivePrompt });

    expect(result.ok).toBe(false);
    expect(result.garbled_text_detected).toBe(true);
    expect(result.issues).toContain('「法」が崩れている');
  });

  it('includes subtitle in the user message when provided', async () => {
    const { createAgentClient, loadActivePrompt, complete } = makeDeps();

    await verifyCoverText(baseInput({ subtitle: '初心者向け完全ガイド' }), {
      createAgentClient,
      loadActivePrompt,
    });

    const completeArg = complete.mock.calls[0]![0] as unknown as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMsg = completeArg.messages.find((m) => m.role === 'user')!;
    expect(userMsg.content).toContain('初心者向け完全ガイド');
  });
});
