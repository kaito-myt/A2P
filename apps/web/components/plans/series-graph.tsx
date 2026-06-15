'use client';

/**
 * SeriesGraph — シリーズ系統図 (T-08-02, S-005).
 *
 * mermaid ランタイムがアプリに存在しないため、シンプルな flex ボックス +
 * 矢印レイアウトで代替する。既存シリーズ (ソリッド枠) と候補 (破線枠) を
 * 横方向に並べ、→ で繋ぐ。
 *
 * NOTE: mermaid ライブラリが将来追加された場合は本コンポーネントを
 *       <pre class="mermaid"> ベースに置き換えること。
 */
import { ArrowRight } from 'lucide-react';

import { messages } from '@/lib/messages';
import type { PlanMonthView } from '@/lib/plans-view';

const m = messages.plans.seriesGraph;

interface SeriesNode {
  label: string;
  isCandidate: boolean;
}

interface SeriesChain {
  nodes: SeriesNode[];
}

/**
 * months 配列から series_candidates を集約して系統グラフ用チェーンを構築する。
 * 同じ候補ラベルは重複除去する。
 */
function buildSeriesChains(months: PlanMonthView[]): SeriesChain[] {
  const seen = new Set<string>();
  const chains: SeriesChain[] = [];

  for (const month of months) {
    for (const candidate of month.series_candidates) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);

      // "Vol." / "第 N 弾" / "応用" 等のパターンで series lineage を推測する
      // シンプルに: 候補タイトルの最初の候補を親、以降を子とした 1 本のチェーンで表現
      chains.push({
        nodes: [
          // 既存書籍 (仮) として親ノードを"シリーズ本体"として表示
          {
            label: derivedParentLabel(candidate),
            isCandidate: false,
          },
          {
            label: candidate,
            isCandidate: true,
          },
        ],
      });
    }
  }

  return chains;
}

/**
 * 候補タイトルから仮の親ラベルを導出する。
 * "副業の応用" → "副業の基礎" のような推測は LLM 依存なので、
 * ここではシンプルにシリーズ名を「〜（既刊）」として返す。
 */
function derivedParentLabel(candidate: string): string {
  // "Vol." や "第 N 弾" を取り除いたベース名を既存として表示
  return candidate.replace(/\s*(Vol\.\s*\d+|第\s*\d+\s*弾|続編|Part\s*\d+)$/i, '').trim() || candidate;
}

interface SeriesGraphProps {
  months: PlanMonthView[];
}

export function SeriesGraph({ months }: SeriesGraphProps) {
  const chains = buildSeriesChains(months);

  return (
    <section aria-label={m.sectionTitle}>
      <h2 className="mb-3 text-sub-heading text-foreground">{m.sectionTitle}</h2>

      {chains.length === 0 ? (
        <p className="text-body text-muted">{m.noSeries}</p>
      ) : (
        <div className="flex flex-col gap-4 rounded-card border border-border-warm bg-cream-light p-4">
          {/* 凡例 */}
          <div className="flex items-center gap-4 text-button-sm text-muted">
            <span className="flex items-center gap-1">
              <span className="inline-block h-4 w-8 rounded border border-charcoal bg-cream-light" />
              {m.existingLabel}
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-4 w-8 rounded border border-dashed border-charcoal bg-cream-light" />
              {m.candidateLabel}
            </span>
          </div>

          {/* チェーン */}
          <div className="flex flex-col gap-3">
            {chains.map((chain, chainIdx) => (
              <div
                key={chainIdx}
                className="flex flex-wrap items-center gap-2"
                role="group"
                aria-label={`シリーズ系統 ${chainIdx + 1}`}
              >
                {chain.nodes.map((node, nodeIdx) => (
                  <div key={nodeIdx} className="flex items-center gap-2">
                    {/* ノード */}
                    <div
                      className={[
                        'rounded-sm px-3 py-1.5 text-button-sm text-foreground',
                        node.isCandidate
                          ? 'border border-dashed border-charcoal bg-white'
                          : 'border border-charcoal bg-cream-light font-medium',
                      ].join(' ')}
                      aria-label={node.isCandidate ? `${node.label}（候補）` : `${node.label}（既存）`}
                    >
                      {node.label}
                    </div>

                    {/* 矢印 (最後のノード以外) */}
                    {nodeIdx < chain.nodes.length - 1 && (
                      <ArrowRight
                        className="h-4 w-4 flex-shrink-0 text-muted"
                        aria-hidden="true"
                      />
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
