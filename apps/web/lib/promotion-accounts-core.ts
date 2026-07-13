/**
 * docs/06 P4 増分2 — 販促アカウント台帳 (promotion_accounts) の接続コアロジック。
 *
 * account_strategist が pending で積んだアカウントを、運営者が「一度だけ」接続する
 * （handle + アクセストークンを保存し status=connected へ）。以降は org が投稿を
 * 自動振り分けする。作成/サインアップそのものは規約/KYC のため org は行わない。
 *
 * 実 IO (prisma/crypto) は deps 経由。副作用の無い純ロジックとして検証可能にする。
 */
import { z } from 'zod';

import { fail, ok, type ActionResult } from '@a2p/contracts';

import { messages } from '@/lib/messages';

const m = messages.org.accounts;

export interface AccountRow {
  id: string;
  channel: string;
  niche: string;
  status: string;
  handle: string | null;
  token_enc: string | null;
  token_mask: string | null;
  config_json: unknown;
}

export interface PromotionAccountsDeps {
  accountRepo: {
    findUnique: (args: { where: { id: string } }) => Promise<AccountRow | null>;
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
  };
  auditLogRepo: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
  session: { user: { id: string } };
  encrypt: (plain: string) => string;
  mask: (plain: string) => string;
}

/** 所有チャンネル（第三者接続不要で connected 扱いにできる）。 */
const OWNED_CHANNELS = new Set<string>(['blog']);

const ConnectSchema = z.object({
  account_id: z.string().min(1),
  handle: z.string().max(200).optional(),
  /** 空/未指定は「変更なし」。新規トークンのときだけ暗号化保存。 */
  token: z.string().max(4000).optional(),
  webhook_url: z.string().url().max(500).optional().or(z.literal('')),
});

export async function connectPromotionAccountCore(
  input: unknown,
  deps: PromotionAccountsDeps,
): Promise<ActionResult<{ account_id: string; connected: boolean }>> {
  const parsed = ConnectSchema.safeParse(input);
  if (!parsed.success) return fail('validation', m.error);
  const { account_id, handle, token, webhook_url } = parsed.data;

  const existing = await deps.accountRepo.findUnique({ where: { id: account_id } });
  if (!existing) return fail('not_found', m.error);

  const config = {
    ...((existing.config_json as Record<string, unknown> | null) ?? {}),
    ...(webhook_url !== undefined ? { webhook_url: webhook_url || null } : {}),
  };

  const update: Record<string, unknown> = {
    handle: handle && handle.trim().length > 0 ? handle.trim() : existing.handle,
    config_json: config,
  };
  if (token && token.trim().length > 0) {
    update.token_enc = deps.encrypt(token.trim());
    update.token_mask = deps.mask(token.trim());
  }

  // 資格情報が揃えば connected に昇格（所有チャンネルはトークン不要）。
  const hasToken = Boolean(update.token_enc) || Boolean(existing.token_enc);
  const hasWebhook = Boolean(config.webhook_url);
  const connected = hasToken || hasWebhook || OWNED_CHANNELS.has(existing.channel);
  update.status = connected ? 'connected' : 'pending';

  await deps.accountRepo.update({ where: { id: account_id }, data: update });
  await deps.auditLogRepo.create({
    data: {
      actor_id: deps.session.user.id,
      action: 'promotion.account.connect',
      target_kind: 'promotion_account',
      target_id: account_id,
      // token は監査ログに残さない。
      after_json: { channel: existing.channel, handle: update.handle, connected, token_updated: Boolean(update.token_enc) },
    },
  });

  return ok({ account_id, connected });
}

const ArchiveSchema = z.object({ account_id: z.string().min(1) });

export async function archivePromotionAccountCore(
  input: unknown,
  deps: PromotionAccountsDeps,
): Promise<ActionResult<{ account_id: string }>> {
  const parsed = ArchiveSchema.safeParse(input);
  if (!parsed.success) return fail('validation', m.error);
  const { account_id } = parsed.data;

  const existing = await deps.accountRepo.findUnique({ where: { id: account_id } });
  if (!existing) return fail('not_found', m.error);

  await deps.accountRepo.update({ where: { id: account_id }, data: { status: 'archived' } });
  await deps.auditLogRepo.create({
    data: {
      actor_id: deps.session.user.id,
      action: 'promotion.account.archive',
      target_kind: 'promotion_account',
      target_id: account_id,
      after_json: { channel: existing.channel },
    },
  });
  return ok({ account_id });
}
