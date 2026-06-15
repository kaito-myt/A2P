'use client';

/**
 * GenrePolicyEditor (S-004 Section 3)。
 *
 * docs/05 §3 Account.genre_policy_json:
 *   { primary_genre, ratio: Record<string, number>, focus_themes: string[] }
 *
 * UI:
 *   - 主ジャンル ラジオ
 *   - 3 種の比率を 0〜100 整数 % で編集 (内部で 0〜1 に正規化)
 *   - 注力テーマ カンマ区切り
 *
 * 値の送出は hidden input `genre_policy_json` に JSON 文字列で詰める。
 * サーバー側 (accounts-core.createAccountInput) が JSON.parse + zod 検証。
 */
import { useMemo, useState } from 'react';
import { messages } from '@/lib/messages';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Genre = 'practical' | 'business' | 'self_help';

export interface GenrePolicyValue {
  primary_genre: Genre;
  ratio: Record<string, number>;
  focus_themes: string[];
}

interface GenrePolicyEditorProps {
  name: string;
  defaultValue?: GenrePolicyValue;
}

const DEFAULT_VALUE: GenrePolicyValue = {
  primary_genre: 'practical',
  ratio: { practical: 0.4, business: 0.35, self_help: 0.25 },
  focus_themes: [],
};

export function GenrePolicyEditor({ name, defaultValue }: GenrePolicyEditorProps) {
  const m = messages.accounts;
  const init = defaultValue ?? DEFAULT_VALUE;
  const [primary, setPrimary] = useState<Genre>(init.primary_genre);
  const [ratios, setRatios] = useState({
    practical: pctOf(init.ratio.practical),
    business: pctOf(init.ratio.business),
    self_help: pctOf(init.ratio.self_help),
  });
  const [focusThemes, setFocusThemes] = useState((init.focus_themes ?? []).join(', '));

  const total = ratios.practical + ratios.business + ratios.self_help;
  const isBalanced = total === 100;

  const serialized = useMemo(
    () =>
      JSON.stringify({
        primary_genre: primary,
        ratio: {
          practical: round2(ratios.practical / 100),
          business: round2(ratios.business / 100),
          self_help: round2(ratios.self_help / 100),
        },
        focus_themes: focusThemes
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .slice(0, 20),
      }),
    [primary, ratios, focusThemes],
  );

  return (
    <div className="flex flex-col gap-space-relaxed">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-button-sm font-normal text-charcoal-83">
          {m.detail.primaryGenreLabel}
        </legend>
        <div className="flex flex-wrap gap-space-relaxed">
          {(['practical', 'business', 'self_help'] as const).map((g) => (
            <label key={g} className="flex items-center gap-2 text-body">
              <input
                type="radio"
                name={`${name}__primary`}
                value={g}
                checked={primary === g}
                onChange={() => setPrimary(g)}
              />
              <span>{m.table.genres[g]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <Label>{m.detail.ratioLabel}</Label>
        <div className="grid grid-cols-1 gap-space-snug sm:grid-cols-3">
          {(['practical', 'business', 'self_help'] as const).map((g) => (
            <div key={g} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-button-sm text-muted">
                {m.table.genres[g]}
              </span>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                step={1}
                value={ratios[g]}
                onChange={(e) =>
                  setRatios((prev) => ({
                    ...prev,
                    [g]: clampPct(Number(e.target.value)),
                  }))
                }
                className="w-24"
              />
              <span className="text-button-sm text-muted">%</span>
            </div>
          ))}
        </div>
        <div className="text-button-sm text-muted">合計: {total}%</div>
        {!isBalanced && (
          <p className="text-button-sm text-warning">{m.detail.ratioWarning}</p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={`${name}__focus`}>{m.detail.focusThemesLabel}</Label>
        <Input
          id={`${name}__focus`}
          value={focusThemes}
          onChange={(e) => setFocusThemes(e.target.value)}
          placeholder={m.detail.focusThemesPlaceholder}
        />
      </div>

      <input type="hidden" name={name} value={serialized} />
    </div>
  );
}

function pctOf(v: number | undefined): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0;
  return Math.round(v * 100);
}

function clampPct(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
