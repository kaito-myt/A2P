# Contributing to A2P

このリポジトリは個人運用ツールだが、ハーネスエージェント間で守るべき機械的規約がいくつかある。
PR を出す前 (および programmer エージェントが `## DONE` を出す前) に以下のローカルチェックを必ず PASS させること。

## ローカル必須チェック

```bash
pnpm typecheck         # 全 workspace の TypeScript 型検査
pnpm test:unit         # Vitest ユニットテスト
pnpm check:env         # .env.example と zod スキーマのキー集合一致
pnpm check:llm-client  # LLM クライアント直接生成の禁止 (本ドキュメント §LLM クライアント取得規約)
```

CI (`.github/workflows/ci.yml`) でも同じジョブが走るが、ローカルで先に通しておくこと。

## LLM クライアント取得規約

`docs/05 §10.1` / `CLAUDE.md` Hard Rule 5 に基づく機械的ガード。

### ルール

LLM クライアント (`AISdkClient`, `AgentSdkClient`) は、必ず **ファクトリ `createAgentClient(role, genre, ctx)`**
(`packages/agents/src/lib/llm-client-factory.ts`) 経由で取得する。

```ts
// OK: ファクトリ経由
import { createAgentClient } from '@a2p/agents/lib/llm-client-factory';
const client = await createAgentClient('writer', 'business', { bookId, jobId });
const result = await client.complete({ system, user });

// NG: 生インスタンス化 (CI で fail)
import { AISdkClient } from '@a2p/agents/lib/ai-sdk-client';
const client = new AISdkClient({ provider: 'openai', model: 'gpt-5', apiKey: '...' });
```

### なぜか

- `createAgentClient` は内部で `withTokenLogging` ミドルウェアを噛ませている
- これにより 1 回の `complete()` 呼び出しごとに `token_usage` テーブルへ自動 INSERT され、
  `books.cost_jpy_total` が atomic にインクリメントされる
- 生インスタンス化はこのミドルウェアを迂回するため、トークン使用量とコストが記録されず、
  `CLAUDE.md` Hard Rule 5「全 Claude/OpenAI 呼出は token_usage に記録」に違反する

### 例外 (許可される直接 `new`)

CI スクリプト (`scripts/check-llm-client-usage.ts`) は以下のパスでは違反扱いしない:

- `packages/agents/src/lib/llm-client-factory.ts` — 唯一の正規生成ルート
- `packages/agents/src/lib/ai-sdk-client.ts` / `agent-sdk-client.ts` — クラス定義そのもの
- `**/__tests__/**` — ユニットテストでは直接モックする必要がある
- `tests/e2e/**` — E2E でも検証用に必要な場合あり

### 個別エスケープハッチ

やむを得ず上記許可リスト外で直接 `new` する必要がある場合は、行末コメントで明示する:

```ts
const c = new AISdkClient({ provider, model, apiKey }); // llm-client-guard:allow
```

ただし使用は最小限に抑え、PR レビューで必ず正当性を説明すること。

### 違反検出時の挙動

```
[check-llm-client] FAIL: 1 raw LLM client instantiation(s) found outside the factory:
  apps/web/lib/foo.ts:42: const c = new AISdkClient({ ... });

  Fix: use `createAgentClient(role, genre, ctx)` from `packages/agents/src/lib/llm-client-factory.ts`.
```

CI ジョブ `check-llm-client` が exit 1 で fail し、マージ不可となる。

## その他の規約

- **設計書ファースト**: アーキテクチャ変更は `docs/05-program-design.md` への追記提案を先に行う
- **シークレット禁止**: コードに `sk-...` 等を直書きせず、必ず `process.env.X` 経由 (実際の値は `.env.local` のみ)
- **日本語文言の集約**: UI 文言は i18n 辞書 / 定数ファイルに集約し、コンポーネントに直書きしない
- **コミット粒度**: 1 タスク = 1 PR を原則とする (ハーネス `/iterate` ループに合わせる)
