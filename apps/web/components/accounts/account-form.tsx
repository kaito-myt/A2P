'use client';

/**
 * AccountForm (S-004)。
 *
 * 新規モード (`mode='create'`) と編集モード (`mode='edit'`) を切り替える。
 * FormData をパースして Server Action (`createAccount` / `updateAccount`) を呼ぶ。
 *
 * 集約方針:
 *   - 文言は messages.accounts.detail に集約
 *   - 値の zod 検証はサーバー側 (accounts-core) に委譲。クライアント側は
 *     最低限の入力欄定義と SA エラーメッセージ表示のみを担う
 */
import { useTransition, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createAccount, updateAccount } from '@/app/actions/accounts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { messages } from '@/lib/messages';
import { SecretField } from './secret-field';
import { GenrePolicyEditor, type GenrePolicyValue } from './genre-policy-editor';

export interface AccountFormDefaults {
  id?: string;
  pen_name?: string;
  display_name?: string | null;
  bio?: string | null;
  target_reader?: string | null;
  genre_policy?: GenrePolicyValue;
  kdp_credentials_set: boolean;
}

interface AccountFormProps {
  mode: 'create' | 'edit';
  defaults?: AccountFormDefaults;
}

export function AccountForm({ mode, defaults }: AccountFormProps) {
  const m = messages.accounts.detail;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const isEdit = mode === 'edit';

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    const fd = new FormData(e.currentTarget);

    const genrePolicyRaw = fd.get('genre_policy_json');
    let genre_policy: unknown;
    try {
      genre_policy =
        typeof genrePolicyRaw === 'string' ? JSON.parse(genrePolicyRaw) : undefined;
    } catch {
      setErrorMessage(m.errors.validation);
      return;
    }

    const kdpEmail = fd.get('kdp_email');
    const kdpPassword = fd.get('kdp_password');
    const kdpTotp = fd.get('kdp_totp');
    let kdp_credentials: unknown;
    if (typeof kdpEmail === 'string' && typeof kdpPassword === 'string') {
      kdp_credentials = {
        email: kdpEmail,
        password: kdpPassword,
        ...(typeof kdpTotp === 'string' && kdpTotp.length > 0
          ? { totp_secret: kdpTotp }
          : {}),
      };
    }

    const base: Record<string, unknown> = {
      pen_name: stringOrUndef(fd.get('pen_name')),
      display_name: stringOrUndef(fd.get('display_name')),
      bio: stringOrUndef(fd.get('bio')),
      target_reader: stringOrUndef(fd.get('target_reader')),
      genre_policy,
      ...(kdp_credentials !== undefined ? { kdp_credentials } : {}),
    };

    startTransition(async () => {
      if (isEdit) {
        if (!defaults?.id) {
          setErrorMessage(m.errors.notFound);
          return;
        }
        const result = await updateAccount({ id: defaults.id, ...base });
        if (result.ok) {
          setSuccessMessage(m.successUpdate);
          router.refresh();
        } else {
          setErrorMessage(result.error.message);
        }
      } else {
        const result = await createAccount(base);
        if (result.ok) {
          setSuccessMessage(m.successCreate);
          router.push(`/accounts/${result.data.id}`);
          router.refresh();
        } else {
          setErrorMessage(result.error.message);
        }
      }
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className="grid grid-cols-1 gap-space-loose lg:grid-cols-[2fr_1fr]"
    >
      {/* 左カラム: 基本情報 + ジャンル方針 + KDP */}
      <div className="flex flex-col gap-space-loose">
        <Card>
          <CardHeader>
            <CardTitle>{m.sectionBasic}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-space-relaxed">
            <div className="flex flex-col gap-1">
              <Label htmlFor="pen_name">{m.penNameLabel}</Label>
              <Input
                id="pen_name"
                name="pen_name"
                required
                maxLength={50}
                defaultValue={defaults?.pen_name ?? ''}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="display_name">{m.displayNameLabel}</Label>
              <Input
                id="display_name"
                name="display_name"
                maxLength={50}
                defaultValue={defaults?.display_name ?? ''}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="bio">{m.bioLabel}</Label>
              <Textarea
                id="bio"
                name="bio"
                rows={4}
                maxLength={1000}
                defaultValue={defaults?.bio ?? ''}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="target_reader">{m.targetReaderLabel}</Label>
              <Textarea
                id="target_reader"
                name="target_reader"
                rows={3}
                maxLength={500}
                defaultValue={defaults?.target_reader ?? ''}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{m.sectionGenre}</CardTitle>
          </CardHeader>
          <CardContent>
            <GenrePolicyEditor
              name="genre_policy_json"
              defaultValue={defaults?.genre_policy}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{m.sectionKdp}</CardTitle>
            <p className="text-button-sm text-muted">{m.kdpNote}</p>
          </CardHeader>
          <CardContent className="flex flex-col gap-space-relaxed">
            <p className="rounded-default border border-warning/40 bg-warning-bg/40 px-3 py-2 text-button-sm text-warning">
              {m.kdpPhase3Note}
            </p>
            <SecretField
              name="kdp_email"
              label={m.kdpEmailLabel}
              type="email"
              hasExistingValue={defaults?.kdp_credentials_set ?? false}
            />
            <SecretField
              name="kdp_password"
              label={m.kdpPasswordLabel}
              type="password"
              hasExistingValue={defaults?.kdp_credentials_set ?? false}
            />
            <SecretField
              name="kdp_totp"
              label={m.kdpTotpLabel}
              type="text"
              hasExistingValue={defaults?.kdp_credentials_set ?? false}
            />
          </CardContent>
        </Card>
      </div>

      {/* 右カラム: プラン要約 + KPI (Phase 1 は placeholder) */}
      <div className="flex flex-col gap-space-loose">
        <Card>
          <CardHeader>
            <CardTitle>{m.sectionPlan}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-space-snug">
            <p className="text-body text-muted">{m.planSummaryPlaceholder}</p>
            <div className="flex flex-wrap gap-space-snug">
              <Button type="button" variant="outline" size="sm" disabled>
                {m.planView}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled>
                {m.planRegenerate}
              </Button>
            </div>
          </CardContent>
        </Card>

        <AccountKpiCard />
      </div>

      {/* ページヘッダーアクション (sticky 下部に 1 セット) */}
      <div className="lg:col-span-2">
        <div className="sticky bottom-0 -mx-space-loose flex items-center justify-between gap-space-snug border-t border-border-warm bg-cream px-space-loose py-space-snug">
          <div className="text-button-sm">
            {errorMessage && <span className="text-destructive">{errorMessage}</span>}
            {successMessage && <span className="text-success">{successMessage}</span>}
          </div>
          <div className="flex gap-space-snug">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.back()}
              disabled={pending}
            >
              {m.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? m.saving : m.save}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

function stringOrUndef(v: FormDataEntryValue | null): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function AccountKpiCard() {
  const m = messages.accounts.detail;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.sectionKpi}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-space-snug">
          <KpiRow label={m.kpiPublished} value="0" suffix={messages.accounts.table.countSuffix} />
          <KpiRow label={m.kpiSales} value="¥0" />
          <KpiRow label={m.kpiQuality} value="—" />
          <KpiRow label={m.kpiCost} value="¥0" />
        </dl>
      </CardContent>
    </Card>
  );
}

function KpiRow({
  label,
  value,
  suffix,
}: {
  label: string;
  value: string;
  suffix?: string;
}) {
  return (
    <div className="flex items-baseline justify-between border-b border-border-warm pb-2 last:border-b-0">
      <dt className="text-button-sm text-muted">{label}</dt>
      <dd className="flex items-baseline gap-1 text-card-title text-foreground">
        <span>{value}</span>
        {suffix && <span className="text-button-sm text-muted">{suffix}</span>}
      </dd>
    </div>
  );
}
