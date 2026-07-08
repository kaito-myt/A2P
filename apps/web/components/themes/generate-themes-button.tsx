'use client';

/**
 * GenerateThemesModal — S-006 「新規テーマ生成」(F-001)。
 *
 * Marketer エージェントにテーマ候補を生成させる。`generateThemes` SA を呼び、
 * 成功したら該当セッションへ遷移する。生成は worker の非同期ジョブのため、
 * 候補は数十秒〜2分後に出る → 遷移先で「生成中」を案内し、更新で反映される。
 */
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { generateThemes } from '@/app/actions/themes';
import { messages } from '@/lib/messages';

const m = messages.themes;

export interface GenerateThemesAccount {
  id: string;
  pen_name: string;
}

export interface NameOption {
  id: string;
  name: string;
}

type Genre = 'practical' | 'business' | 'self_help' | '';

const GENRE_OPTIONS: Array<{ value: Genre; label: string }> = [
  { value: '', label: 'おまかせ（指定なし）' },
  { value: 'practical', label: '実用書' },
  { value: 'business', label: 'ビジネス書' },
  { value: 'self_help', label: '自己啓発' },
];

export function GenerateThemesButton({
  accounts = [],
  authors = [],
  labels = [],
}: {
  accounts?: GenerateThemesAccount[];
  authors?: NameOption[];
  labels?: NameOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [keywordOrBrief, setKeywordOrBrief] = useState('');
  const [genre, setGenre] = useState<Genre>('practical');
  const [count, setCount] = useState(5);
  const [authorNameId, setAuthorNameId] = useState('');
  const [labelNameId, setLabelNameId] = useState('');

  const noAccounts = accounts.length === 0;

  function submit() {
    setError(null);
    if (!accountId) {
      setError('アカウントを選択してください');
      return;
    }
    if (keywordOrBrief.trim().length === 0) {
      setError('キーワード／概要を入力してください');
      return;
    }
    startTransition(async () => {
      const res = await generateThemes({
        accountId,
        genre: genre === '' ? null : genre,
        keywordOrBrief: keywordOrBrief.trim(),
        count,
        authorNameId: authorNameId || null,
        labelNameId: labelNameId || null,
      });
      if (!res.ok) {
        setError(res.error?.message ?? 'テーマ生成に失敗しました');
        return;
      }
      setOpen(false);
      setKeywordOrBrief('');
      router.push(`/themes?theme_session_id=${res.data.session_id}`);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="default"
        onClick={() => setOpen(true)}
        data-testid="themes-generate-button"
      >
        {m.generateButton}
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget && !pending) setOpen(false);
          }}
        >
          <div className="w-full max-w-lg rounded-card border border-border-warm bg-cream p-space-loose shadow-xl">
            <h2 className="text-card-title text-charcoal">新規テーマ生成</h2>
            <p className="mt-1 text-button-sm text-muted">
              キーワードや企画概要を入力すると、マーケターがテーマ候補を提案します。
            </p>

            {noAccounts ? (
              <div className="mt-space-snug rounded-default border border-border-warm bg-cream-light p-4 text-button-sm text-charcoal">
                先にアカウントを作成してください。
                <a href="/accounts/new" className="ml-1 underline">
                  アカウント作成へ
                </a>
              </div>
            ) : (
              <div className="mt-space-snug flex flex-col gap-space-snug">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="gt-account">アカウント</Label>
                  <select
                    id="gt-account"
                    className="rounded-default border border-border-warm bg-cream-light px-3 py-2 text-body text-charcoal"
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                    disabled={pending}
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.pen_name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <Label htmlFor="gt-keyword">キーワード／企画概要</Label>
                  <Textarea
                    id="gt-keyword"
                    rows={3}
                    placeholder="例：新潟競馬場の必勝法（コース特性・血統・枠順・展開を踏まえた馬券戦略）"
                    value={keywordOrBrief}
                    onChange={(e) => setKeywordOrBrief(e.target.value)}
                    disabled={pending}
                    maxLength={500}
                  />
                </div>

                <div className="flex gap-space-snug">
                  <div className="flex flex-1 flex-col gap-1">
                    <Label htmlFor="gt-genre">ジャンル</Label>
                    <select
                      id="gt-genre"
                      className="rounded-default border border-border-warm bg-cream-light px-3 py-2 text-body text-charcoal"
                      value={genre}
                      onChange={(e) => setGenre(e.target.value as Genre)}
                      disabled={pending}
                    >
                      {GENRE_OPTIONS.map((g) => (
                        <option key={g.value} value={g.value}>
                          {g.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex w-28 flex-col gap-1">
                    <Label htmlFor="gt-count">生成数</Label>
                    <Input
                      id="gt-count"
                      type="number"
                      min={1}
                      max={30}
                      value={count}
                      onChange={(e) => setCount(Number(e.target.value))}
                      disabled={pending}
                    />
                  </div>
                </div>

                <div className="flex gap-space-snug">
                  <div className="flex flex-1 flex-col gap-1">
                    <Label htmlFor="gt-author">著者名</Label>
                    <select
                      id="gt-author"
                      className="rounded-default border border-border-warm bg-cream-light px-3 py-2 text-body text-charcoal"
                      value={authorNameId}
                      onChange={(e) => setAuthorNameId(e.target.value)}
                      disabled={pending}
                    >
                      <option value="">（指定なし・後で設定）</option>
                      {authors.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-1 flex-col gap-1">
                    <Label htmlFor="gt-label">レーベル名</Label>
                    <select
                      id="gt-label"
                      className="rounded-default border border-border-warm bg-cream-light px-3 py-2 text-body text-charcoal"
                      value={labelNameId}
                      onChange={(e) => setLabelNameId(e.target.value)}
                      disabled={pending}
                    >
                      <option value="">（指定なし・後で設定）</option>
                      {labels.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {authors.length === 0 && labels.length === 0 && (
                  <p className="text-caption text-muted">
                    著者名・レーベル名は{' '}
                    <a href="/masters" className="underline">
                      マスタ管理
                    </a>{' '}
                    で登録するとここで選べます。
                  </p>
                )}
              </div>
            )}

            {error && (
              <p className="mt-space-snug text-button-sm text-red-600" role="alert">
                {error}
              </p>
            )}

            <div className="mt-space-loose flex justify-end gap-space-snug">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                キャンセル
              </Button>
              <Button
                type="button"
                variant="default"
                onClick={submit}
                disabled={pending || noAccounts}
                data-testid="themes-generate-submit"
              >
                {pending ? '生成を起動中…' : 'テーマを生成'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
