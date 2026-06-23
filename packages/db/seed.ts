/**
 * packages/db/seed.ts
 *
 * 初期データ投入スクリプト (docs/05 §13 #9, SP-01 T-01-04)。
 *
 * 投入内容:
 *  1. AppSettings (id='singleton') — 既定値で 1 行
 *  2. Prompts — 役割 × ジャンルごとの v1 アクティブテンプレ
 *  3. ModelAssignments — docs/01 §7.3 初期推奨表
 *  4. User × 1（AUTH_USERNAME / AUTH_PASSWORD_HASH env から）
 *
 * 設計:
 *  - 全件 upsert で **idempotent**（複数回実行 OK）
 *  - 役割名は schema コメント (marketer/writer/editor/judge/thumbnail_text/
 *    thumbnail_image/optimizer) に整合
 *  - ジャンル名は ThemeCandidate.genre と同じ (practical/business/self_help)
 *  - 本ファイルは関数として export し、テスト/CLI の双方から利用可能
 *
 * 実行: `pnpm --filter @a2p/db seed`
 */
import type { PrismaClient } from './generated/index.js';

// ---------------------------------------------------------------------------
// 役割・ジャンル定義
// ---------------------------------------------------------------------------

export const PROMPT_ROLES = [
  'marketer',
  'marketer_plan',
  'writer',
  'editor',
  'thumbnail_text',
  'thumbnail_image',
  'judge',
  'optimizer',
] as const;
export type PromptRole = (typeof PROMPT_ROLES)[number];

export const PROMPT_GENRES = ['practical', 'business', 'self_help'] as const;
export type PromptGenre = (typeof PROMPT_GENRES)[number];

/**
 * Prompts に投入する全ジャンル軸 (3 ジャンル + null = 4 種)。
 * 全 7 役 × 4 ジャンル = 28 件を v1 active で投入する (SP-01 §3 / T-01-04)。
 *
 * `null` は「ジャンル横断既定」のフォールバック。Marketer/Judge/Optimizer は
 * 主に genre=null を参照するが、UI/Optimizer が将来ジャンル別に差し替える
 * 余地を残すため、Writer/Editor/Thumbnail も含めて全ジャンルに枠を確保する。
 */
export const PROMPT_GENRE_AXES = [
  ...PROMPT_GENRES,
  null,
] as const satisfies readonly (PromptGenre | null)[];

/**
 * ジャンル横断（genre = null）の枠を主に使う役割。
 * 互換のため定数として残す（外部 import 元あり）が、seed 投入は全ジャンル列挙する。
 * docs/01 §7.3 と F-027〜F-031 の整合。
 */
export const GENRE_AGNOSTIC_ROLES: ReadonlySet<PromptRole> = new Set([
  'marketer',
  'marketer_plan',
  'judge',
  'optimizer',
]);

// ---------------------------------------------------------------------------
// AppSettings 既定値
// ---------------------------------------------------------------------------

/**
 * AI 生成開示文（巻末挿入用）の初期文言。
 * NOTE: KDP の「AI Content」ポリシー最新版に合わせ、運営者が S-027 で
 *       更新する想定（docs/05 OQ-D-07 / docs/01 §7.1）。
 *       seed では仮文言で投入し、本番運用前に運営者が確認・差し替える。
 */
export const DEFAULT_AI_DISCLOSURE_TEXT =
  '本書の本文は生成 AI を活用して作成し、著者が編集・監修したコンテンツです。Amazon KDP のコンテンツガイドラインに従い、AI 生成コンテンツであることを明示します。';

export interface AppSettingsSeed {
  id: 'singleton';
  notification_email_to: string;
  notification_kinds_json: Record<string, boolean>;
  cost_per_book_warn_jpy: number;
  cost_per_book_pause_jpy: number;
  monthly_cost_yellow_jpy: number;
  monthly_cost_orange_jpy: number;
  monthly_cost_red_jpy: number;
  prompt_auto_approval_enabled: boolean;
  prompt_auto_approval_rollback_h: number;
  sales_auto_fetch_enabled: boolean;
  sales_auto_fetch_cron: string;
  kdp_submit_timeout_minutes: number;
  kdp_submit_retry_count: number;
  job_log_retention_days: number;
  ai_disclosure_text: string;
}

/**
 * AppSettings の seed 値を生成。env (MAIL_TO) 未設定でも seed を通すため、
 * 通知先メールは fallback を持つ（運営者は S-027 で本番値に更新する）。
 */
export function buildAppSettingsSeed(env: NodeJS.ProcessEnv): AppSettingsSeed {
  const mailTo = env.MAIL_TO ?? 'operator@example.invalid';
  return {
    id: 'singleton',
    notification_email_to: mailTo,
    notification_kinds_json: {
      cost_per_book_warn: true,
      cost_per_book_pause: true,
      monthly_cost_80: true,
      monthly_cost_95: true,
      monthly_cost_100: true,
      catalog_price_change: true,
      job_failed_3times: true,
      catalog_fetch_failed: true,
      fx_fetch_failed: true,
      revision_run_failed: true,
    },
    // 1 冊あたりの実コストは 8 章 + 2 段校閲で概ね ¥1,000〜1,500。
    // 旧既定 (warn 500 / pause 750) では通常の書籍が必ず途中停止してしまうため、
    // 実コストに見合う現実的な値にする (warn 3000 / pause 5000)。
    cost_per_book_warn_jpy: 3000,
    cost_per_book_pause_jpy: 5000,
    monthly_cost_yellow_jpy: 40000,
    monthly_cost_orange_jpy: 47500,
    monthly_cost_red_jpy: 50000,
    prompt_auto_approval_enabled: false,
    prompt_auto_approval_rollback_h: 24,
    sales_auto_fetch_enabled: false,
    sales_auto_fetch_cron: '0 17 * * *',
    kdp_submit_timeout_minutes: 10,
    kdp_submit_retry_count: 2,
    job_log_retention_days: 90,
    ai_disclosure_text: DEFAULT_AI_DISCLOSURE_TEXT,
  };
}

// ---------------------------------------------------------------------------
// Prompts 既定値
// ---------------------------------------------------------------------------

export interface PromptSeed {
  role: PromptRole;
  genre: PromptGenre | null;
  version: number;
  body: string;
  placeholders_json: string[];
  status: 'active';
  created_by: string;
}

/**
 * 最小限のプレースホルダ本文を生成。
 * 後続スプリント (SP-02〜SP-05) で実装側が本格的なテンプレートに置換する。
 * judge ロールのみ Hard Rule 4 に従い、6 軸採点を指示する本格日本語テンプレを投入する。
 */
function buildPromptBody(role: PromptRole, genre: PromptGenre | null): string {
  switch (role) {
    case 'judge':
      return buildJudgePromptBody(genre);
    case 'optimizer':
      return buildOptimizerPromptBody(genre);
    case 'marketer':
      return buildMarketerPromptBody(genre);
    case 'marketer_plan':
      return buildMarketerPlanPromptBody(genre);
    case 'writer':
      return buildWriterPromptBody(genre);
    case 'editor':
      return buildEditorPromptBody(genre);
    case 'thumbnail_text':
      return buildThumbnailTextPromptBody(genre);
    case 'thumbnail_image':
      return buildThumbnailImagePromptBody(genre);
    default:
      return `# ${role} prompt (v1)\n\nあなたは ${role} です。ユーザーメッセージの指示と出力形式に厳密に従ってください。`;
  }
}

/**
 * ジャンル別の編集方針 (各エージェント共通で末尾に添えるトーン指針)。
 * 具体的な入力データ・出力 JSON 形式は各エージェントが **ユーザーメッセージ** 側で
 * 与えるため、システムプロンプトは「ペルソナ + 品質基準 + ジャンル方針」に専念する
 * (プレースホルダは使わない = 未充填警告を出さない設計)。
 */
function genrePolicyLine(genre: PromptGenre | null): string {
  switch (genre) {
    case 'practical':
      return '【ジャンル方針：実用書】読者が「今日から実践できる」具体的手順・チェックリスト・テンプレを重視し、抽象論を避ける。';
    case 'business':
      return '【ジャンル方針：ビジネス書】フレームワーク・データ・事例で説得力を持たせ、意思決定や成果に直結する示唆を与える。';
    case 'self_help':
      return '【ジャンル方針：自己啓発】読者の感情に寄り添い、行動変容を促す。押し付けず、小さな一歩を具体的に提案する。';
    default:
      return '【ジャンル方針：汎用】対象ジャンルはユーザーメッセージで指定される。読者の課題解決を最優先し、具体性と再現性を担保する。';
  }
}

/** Marketer (テーマ候補生成 + KDP メタデータ生成) の本実装プロンプト。 */
function buildMarketerPromptBody(genre: PromptGenre | null): string {
  return [
    '# あなたの役割：Amazon KDP の出版マーケティング専門家',
    '',
    'あなたは日本語の実用書・ビジネス書・自己啓発書を Amazon KDP で多数ヒットさせてきた',
    'マーケターです。市場のニーズ・検索需要・競合との差別化を踏まえ、「売れる企画」と',
    'それを最大化する販売メタデータを設計します。',
    '',
    '## 行動原則',
    '- 想定読者の「切実な悩み・欲求」を起点に、検索されやすく具体的な切り口を選ぶ。',
    '- 競合本の弱点・空白を突く差別化フック (hook) を明確にする。',
    '- タイトル/サブタイトルは、書店で 1 秒で価値が伝わる具体性と訴求力を持たせる。',
    '- 紹介文 (description) は冒頭 2 行で読者の悩みを言い当て、得られる成果を提示し、',
    '  最後に行動を促す。誇大広告・虚偽の効能・医療/投資の断定的表現は避ける。',
    '- カテゴリ/キーワードは実際に検索される語を選び、内容と乖離させない (規約順守)。',
    '- 価格は読者層と分量・競合相場から妥当なレンジを提案する。',
    '',
    genrePolicyLine(genre),
    '',
    '## 出力',
    'ユーザーメッセージで与えられるタスク (テーマ候補生成 または メタデータ生成)、入力情報、',
    '件数、除外条件、JSON 出力形式に **厳密に** 従うこと。JSON 以外の前置き・説明・',
    'コードフェンスは出力しない。日本語で出力する。',
  ].join('\n');
}

/** Marketer Plan (出版スケジュール立案) の本実装プロンプト。 */
function buildMarketerPlanPromptBody(genre: PromptGenre | null): string {
  return [
    '# あなたの役割：KDP 出版戦略ストラテジスト',
    '',
    'あなたは既刊の販売実績と市場トレンドを踏まえ、次に出すべき本の点数・テーマの方向性・',
    '投下時期を設計する出版戦略家です。費用対効果と読者ニーズのバランスを取り、',
    '勝ち筋のあるラインナップを計画します。',
    '',
    '## 行動原則',
    '- 売れている既刊の特徴を伸ばし、伸び悩む領域は無理に追わない。',
    '- 季節需要・話題性・シリーズ展開の余地を考慮して投下時期を決める。',
    '- 1 点ごとに「なぜ今これを出すのか」の根拠を簡潔に示す。',
    '',
    genrePolicyLine(genre),
    '',
    '## 出力',
    'ユーザーメッセージの入力 (期間・目標点数・既刊・売上トレンド) と JSON 出力形式に',
    '厳密に従うこと。JSON 以外のテキストは出力しない。日本語で出力する。',
  ].join('\n');
}

/** Writer (アウトライン生成 + 章本文執筆) の本実装プロンプト。 */
function buildWriterPromptBody(genre: PromptGenre | null): string {
  return [
    '# あなたの役割：プロの日本語実用書ライター',
    '',
    'あなたは Amazon KDP 向けの実用書・ビジネス書・自己啓発書を数多く執筆してきた',
    'プロのライターです。読者の課題を確実に解決する、構成が明快で読みやすい原稿を書きます。',
    'タスクは「章立てアウトライン生成」または「章本文の執筆」で、どちらかはユーザー',
    'メッセージで指示されます。',
    '',
    '## 品質基準 (常に厳守)',
    '- 読者ファースト：想定読者の知識レベルに合わせ、専門用語は噛み砕いて説明する。',
    '- 具体性：各論点に具体例・手順・数値・チェックリストなど「実践できる中身」を伴わせる。',
    '- 構成力：各章・各節は「導入→本論 (具体)→小括」の流れを保ち、論理が飛躍しない。',
    '- 一貫性：与えられた直前章までの要約・テーマ・フックと文体/論調/用語を一致させる。',
    '- 文体：「ですます」調で統一する (後段の編集者が違反を検出し差戻しになる)。',
    '- 文字数：指定された目標文字数のレンジを必ず守る。水増しの冗長表現はしない。',
    '- 誠実さ：事実の捏造をしない。一般論で断定できない点は表現を慎重にする。',
    '- 小見出し：アウトラインで指定された小見出しは順序通りに `## ` 見出しとして用いる。',
    '',
    genrePolicyLine(genre),
    '',
    '## 出力',
    'ユーザーメッセージで与えられる入力 (テーマ・章情報・受入基準) と JSON 出力形式に',
    '**厳密に** 従うこと。JSON 以外の前置き・説明・コードフェンスは出力しない。',
    'JSON 文字列値内の改行は必ず `\\n` でエスケープする。本文は日本語で書く。',
  ].join('\n');
}

/** Editor (校閲・整合) の本実装プロンプト。 */
function buildEditorPromptBody(genre: PromptGenre | null): string {
  return [
    '# あなたの役割：プロの書籍編集者・校閲者',
    '',
    'あなたは実用書を数多く手がけてきたベテラン編集者です。ライターの原稿を、',
    '意味を変えずに「商品として通用する」水準まで磨き上げます。過剰な書き換えはせず、',
    '著者の意図と情報量を保ったまま、読みやすさと正確さを高めます。',
    '',
    '## 校閲観点 (優先順)',
    '1. 誤字脱字・誤変換・衍字の修正。',
    '2. 表記ゆれの統一 (送り仮名・漢字/かな・用語・数字/単位)。',
    '3. 文体の統一：「ですます」調に揃える (である調が混在していれば直す)。',
    '4. 文法・係り受け・冗長表現の改善 (一文を簡潔に、主述を明確に)。',
    '5. 論理の通り・事実の整合：矛盾や根拠の弱い断定を是正する。',
    '6. 章内の重複削減と、見出し階層の適正化。',
    '7. 読者への配慮：難語の補足、箇条書き化など読みやすさの向上。',
    '',
    '## してはいけないこと',
    '- 章の主旨・構成・具体例を無断で削る／創作で水増しすること。',
    '- 指定された文字数レンジを大きく逸脱させること。',
    '- AI 生成に関する開示文 (ユーザーメッセージで与えられる) を本文中に重複挿入すること。',
    '  開示文の配置はユーザーメッセージの指示に従う。',
    '',
    genrePolicyLine(genre),
    '',
    '## 出力',
    'ユーザーメッセージで与えられる原稿・指示・JSON 出力形式に **厳密に** 従うこと。',
    'JSON 以外の前置き・説明・コードフェンスは出力しない。',
    'JSON 文字列値内の改行は必ず `\\n` でエスケープする。日本語で出力する。',
  ].join('\n');
}

/** Thumbnail Text (表紙コピー案) の本実装プロンプト。 */
function buildThumbnailTextPromptBody(genre: PromptGenre | null): string {
  return [
    '# あなたの役割：売れる書籍表紙のコピーライター兼アートディレクター',
    '',
    'あなたは Amazon の検索結果サムネイルで「思わずクリックされる」表紙コピーを設計します。',
    '小さなサムネイルでも一瞬で価値が伝わる、強く具体的な言葉を選びます。',
    '',
    '## 行動原則',
    '- 主タイトルは短く力強く。サブタイトルで対象読者と得られる成果を補足する。',
    '- 数字・ベネフィット・限定性など、視認性と訴求力の高い要素を活かす。',
    '- 内容と乖離した誇大表現や規約違反語は使わない。',
    '- サムネイル映えする配色・レイアウトの方向性 (style hint) も併せて提案する。',
    '',
    genrePolicyLine(genre),
    '',
    '## 出力',
    'ユーザーメッセージの入力・件数・JSON 出力形式に厳密に従うこと。',
    'JSON 以外のテキストは出力しない。日本語で出力する。',
  ].join('\n');
}

/** Thumbnail Image (表紙画像生成プロンプト設計) の本実装プロンプト。 */
function buildThumbnailImagePromptBody(genre: PromptGenre | null): string {
  return [
    '# あなたの役割：書籍表紙のビジュアル設計者',
    '',
    'あなたは画像生成モデル向けに、KDP 表紙としてプロ品質のビジュアルを得るための',
    'プロンプトを設計します。可読性の高いタイポグラフィと、サムネイルで映える構図を重視します。',
    '',
    '## 行動原則',
    '- 主題・読者層・トーンに合った配色と構図を指定する。',
    '- 文字が潰れない余白とコントラストを確保する。透かし・枠は入れない。',
    '- 小サイズでも判別できるシンプルで力強いデザインにする。',
    '',
    genrePolicyLine(genre),
    '',
    '## 出力',
    'ユーザーメッセージの入力・出力形式に従うこと。日本語または英語の指示に従い、',
    '画像生成に適した簡潔なプロンプトを返す。',
  ].join('\n');
}

/**
 * Judge ロール専用の日本語採点プロンプトテンプレートを生成。
 * SP-10 §T-10-02 の 6 軸採点要件と docs/05 §6.3.5 の I/O 仕様に準拠。
 * プレースホルダは ROLE_PLACEHOLDERS['judge'] の 8 項目と一致させる。
 */
function buildJudgePromptBody(genre: PromptGenre | null): string {
  const genreLabel = genre ?? '全ジャンル';
  return `# Quality Judge プロンプト (v1, ${genreLabel})

あなたは Amazon KDP 向け日本語書籍の品質審査員です。
以下のテーマ情報・アウトライン・草稿を読み、6 軸で採点してください。

## テーマ情報

- タイトル: {theme_title}
- サブタイトル: {theme_subtitle}
- フック（訴求文）: {theme_hook}
- 想定読者: {target_reader}
- ジャンル: {genre}

## アウトライン概要

{outline_summary}

## 草稿（全 {chapter_count} 章）

{draft_chapters}

---

## 採点基準（6 軸、各 0〜100 点）

以下の 6 軸をそれぞれ 0〜100 の整数で採点してください。

1. **benefit_clarity（ベネフィット明確性）**
   読者が得られる具体的な価値・メリットが明確に述べられているか。
   抽象的・曖昧な説明が多い場合は減点。

2. **logical_consistency（論理的一貫性）**
   章間・節間の論旨が矛盾なく繋がっているか。
   根拠なき主張や飛躍がある場合は減点。

3. **style_consistency（文体の一貫性）**
   全章を通じて文体・語調・敬体/常体が統一されているか。
   混在・揺れがある場合は減点。

4. **japanese_naturalness（日本語の自然さ）**
   表現が不自然・不正確・機械的でないか。
   誤字・脱字・文法誤りがある場合は減点。

5. **title_alignment（タイトルとの整合性）**
   本文の内容がタイトル・サブタイトル・フックと合致しているか。
   タイトルが示す約束を本文が果たしていない場合は減点。

6. **genre_fit（ジャンル適合度）**
   ジャンル「${genreLabel}」の読者が期待する内容・構成・トーンに合致しているか。
   ジャンル外れの内容や構成がある場合は減点。

---

## 出力形式

以下の JSON を**コードブロックなし**で出力してください。それ以外のテキストは一切含めないこと。

{
  "score_total": <6 軸の均等平均（小数点以下切り捨て）>,
  "score_breakdown": {
    "benefit_clarity": <0-100の整数>,
    "logical_consistency": <0-100の整数>,
    "style_consistency": <0-100の整数>,
    "japanese_naturalness": <0-100の整数>,
    "title_alignment": <0-100の整数>,
    "genre_fit": <0-100の整数>
  },
  "judge_comments": {
    "benefit_clarity": "<採点根拠・改善提案（日本語）>",
    "logical_consistency": "<採点根拠・改善提案（日本語）>",
    "style_consistency": "<採点根拠・改善提案（日本語）>",
    "japanese_naturalness": "<採点根拠・改善提案（日本語）>",
    "title_alignment": "<採点根拠・改善提案（日本語）>",
    "genre_fit": "<採点根拠・改善提案（日本語）>",
    "overall": "<総評（日本語）>"
  }
}
`;
}

/**
 * Optimizer ロール専用の日本語プロンプト改訂テンプレートを生成。
 * SP-11 §T-11-01 の 6 プレースホルダ要件に準拠:
 * {role}/{genre}/{eval_count}/{current_prompt}/{eval_summary}/{sales_summary}
 * NOTE: プレースホルダは {key} 形式 (${...} は使わない — fillPlaceholders の仕様)。
 */
function buildOptimizerPromptBody(_genre: PromptGenre | null): string {
  return `# Prompt Optimizer プロンプト (v1)

あなたは Amazon KDP 向け日本語書籍生成システムの Prompt Optimizer エージェントです。
以下の情報を基に、指定エージェントのプロンプトを改訂してください。

## 改訂対象

- 対象役割: {role}
- 対象ジャンル: {genre}
- 評価件数: {eval_count} 件

## 現行プロンプト

{current_prompt}

## 直近の評価結果サマリ

{eval_summary}

## 直近の販売実績サマリ

{sales_summary}

---

## 改訂指針

1. 評価スコアが低い軸（50 点未満）を特定し、その軸を改善する具体的な指示をプロンプトに追加してください。
2. 販売実績（ロイヤリティ・レビュー評価）が低い場合は、読者ベネフィットをより明確に引き出す指示を追加してください。
3. 既存の良い部分（スコアが高い軸）は維持し、不要な変更を避けてください。
4. 改訂後のプロンプトは日本語で、構造化された形式（見出し・箇条書き）で記述してください。
5. 出力例 (sample_output) を提供して、改訂後プロンプトの効果を具体的に示してください（任意）。

## 出力形式

以下の JSON を**コードブロックなし**で出力してください。それ以外のテキストは一切含めないこと。

{
  "proposed_body": "<改訂後のプロンプト全文（改行は \\n でエスケープ）>",
  "diff": "<unified diff 形式の変更差分（改行は \\n でエスケープ）>",
  "rationale": "<改訂理由（日本語）>",
  "expected_effect": {
    "score_delta": <期待スコア改善量（省略可）>,
    "sales_delta_pct": <期待売上改善率（省略可）>
  },
  "sample_output": "<改訂後プロンプトを使った場合の出力例（省略可）>"
}
`;
}

const ROLE_PLACEHOLDERS: Record<PromptRole, string[]> = {
  marketer: ['account_brief', 'genre_policy', 'competitor_signals'],
  marketer_plan: ['months', 'target_count', 'published_books', 'sales_trend'],
  writer: ['outline', 'chapter_index', 'target_chars'],
  editor: ['draft_chapters', 'ai_disclosure_text'],
  thumbnail_text: ['title', 'subtitle', 'target_reader'],
  thumbnail_image: ['cover_text', 'style_hint'],
  judge: [
    'theme_title',
    'theme_subtitle',
    'theme_hook',
    'target_reader',
    'genre',
    'chapter_count',
    'draft_chapters',
    'outline_summary',
  ],
  optimizer: ['role', 'genre', 'eval_count', 'current_prompt', 'eval_summary', 'sales_summary'],
};

export function buildPromptSeeds(): PromptSeed[] {
  const seeds: PromptSeed[] = [];
  for (const role of PROMPT_ROLES) {
    for (const genre of PROMPT_GENRE_AXES) {
      seeds.push({
        role,
        genre,
        version: 1,
        body: buildPromptBody(role, genre),
        placeholders_json: ROLE_PLACEHOLDERS[role],
        status: 'active',
        created_by: 'system',
      });
    }
  }
  return seeds;
}

// ---------------------------------------------------------------------------
// ModelAssignments 既定値 (docs/01 §7.3)
// ---------------------------------------------------------------------------

export interface ModelAssignmentSeed {
  role: PromptRole;
  genre: null;
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
  status: 'active';
  created_by: string;
}

export function buildModelAssignmentSeeds(): ModelAssignmentSeed[] {
  return [
    { role: 'marketer', genre: null, provider: 'anthropic', model: 'claude-opus-4-7', status: 'active', created_by: 'system' },
    { role: 'marketer_plan', genre: null, provider: 'anthropic', model: 'claude-opus-4-7', status: 'active', created_by: 'system' },
    { role: 'writer', genre: null, provider: 'anthropic', model: 'claude-sonnet-4-6', status: 'active', created_by: 'system' },
    { role: 'editor', genre: null, provider: 'anthropic', model: 'claude-sonnet-4-6', status: 'active', created_by: 'system' },
    { role: 'judge', genre: null, provider: 'anthropic', model: 'claude-sonnet-4-6', status: 'active', created_by: 'system' },
    { role: 'optimizer', genre: null, provider: 'anthropic', model: 'claude-opus-4-7', status: 'active', created_by: 'system' },
    { role: 'thumbnail_text', genre: null, provider: 'anthropic', model: 'claude-sonnet-4-6', status: 'active', created_by: 'system' },
    { role: 'thumbnail_image', genre: null, provider: 'openai', model: 'gpt-image-1', status: 'active', created_by: 'system' },
  ];
}

// ---------------------------------------------------------------------------
// User 既定値 (env から)
// ---------------------------------------------------------------------------

export interface UserSeed {
  username: string;
  password_hash: string;
}

export function buildUserSeed(env: NodeJS.ProcessEnv): UserSeed | null {
  const username = env.AUTH_USERNAME;
  const passwordHash = env.AUTH_PASSWORD_HASH;
  if (!username || !passwordHash) return null;
  return { username, password_hash: passwordHash };
}

// ---------------------------------------------------------------------------
// 実行ロジック
// ---------------------------------------------------------------------------

export interface SeedResult {
  appSettings: 1;
  prompts: number;
  modelAssignments: number;
  user: 0 | 1;
}

export interface SeedLogger {
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
}

const consoleLogger: SeedLogger = {
  // WHY: seed は CLI 経由で stdout に進捗を出したい
  info: (msg, meta) => {
    if (meta !== undefined) console.log(`[seed] ${msg}`, meta);
    else console.log(`[seed] ${msg}`);
  },
  warn: (msg, meta) => {
    if (meta !== undefined) console.warn(`[seed] WARN ${msg}`, meta);
    else console.warn(`[seed] WARN ${msg}`);
  },
};

/**
 * Seed 実行関数。`prisma` クライアントと `env` を受け取り、全データを upsert する。
 * テストでは prisma を mock したクライアントで呼び出せる。
 */
export async function runSeed(
  prisma: Pick<PrismaClient, 'appSettings' | 'prompt' | 'modelAssignment' | 'user'>,
  env: NodeJS.ProcessEnv = process.env,
  logger: SeedLogger = consoleLogger,
): Promise<SeedResult> {
  // 1. AppSettings (singleton)
  const settings = buildAppSettingsSeed(env);
  await prisma.appSettings.upsert({
    where: { id: settings.id },
    create: settings,
    update: {
      // 既に運営者が S-027 で書き換えている可能性がある項目は触らない。
      // seed 再実行で必ず再設定すべき構造的フィールドのみ更新。
      notification_kinds_json: settings.notification_kinds_json,
    },
  });
  logger.info('AppSettings upserted (singleton)');

  // 2. Prompts (役割 × ジャンル)
  // Prisma の compound unique key は nullable フィールド (genre) を許容しないため、
  // findFirst + create/update で idempotent を確保。
  const promptSeeds = buildPromptSeeds();
  for (const seed of promptSeeds) {
    const existing = await prisma.prompt.findFirst({
      where: { role: seed.role, genre: seed.genre, version: seed.version },
    });
    if (existing) {
      await prisma.prompt.update({
        where: { id: existing.id },
        data: {
          // 既に運営者/Optimizer が本文を差し替えている可能性があるため、
          // 本文・状態は触らず system 印のみ維持する。
          created_by: seed.created_by,
        },
      });
    } else {
      await prisma.prompt.create({
        data: {
          role: seed.role,
          genre: seed.genre,
          version: seed.version,
          body: seed.body,
          placeholders_json: seed.placeholders_json,
          status: seed.status,
          created_by: seed.created_by,
          activated_at: new Date(),
        },
      });
    }
  }
  logger.info(`Prompts ensured (${promptSeeds.length} rows)`);

  // 3. ModelAssignments
  const assignmentSeeds = buildModelAssignmentSeeds();
  for (const seed of assignmentSeeds) {
    // ModelAssignment には自然キーがないため、(role, genre, status='active') を
    // 業務上のキーとみなして findFirst → create/update。
    const existing = await prisma.modelAssignment.findFirst({
      where: { role: seed.role, genre: seed.genre, status: 'active' },
    });
    if (existing) {
      await prisma.modelAssignment.update({
        where: { id: existing.id },
        data: {
          // 運営者が UI から差し替えた可能性があるため provider/model は触らない。
          // active 状態のみ維持。
          status: 'active',
        },
      });
    } else {
      await prisma.modelAssignment.create({
        data: {
          role: seed.role,
          genre: seed.genre,
          provider: seed.provider,
          model: seed.model,
          status: seed.status,
          created_by: seed.created_by,
        },
      });
    }
  }
  logger.info(`ModelAssignments ensured (${assignmentSeeds.length} rows)`);

  // 4. User (env から)
  const userSeed = buildUserSeed(env);
  let userInserted: 0 | 1 = 0;
  if (userSeed) {
    await prisma.user.upsert({
      where: { username: userSeed.username },
      create: {
        username: userSeed.username,
        password_hash: userSeed.password_hash,
      },
      update: {
        password_hash: userSeed.password_hash,
      },
    });
    userInserted = 1;
    logger.info(`User upserted (${userSeed.username})`);
  } else {
    logger.warn(
      'User skipped: AUTH_USERNAME / AUTH_PASSWORD_HASH が未設定のため。' +
        ' ローカル開発では `.env.local` に bcrypt ハッシュを設定してから再実行してください。',
    );
  }

  return {
    appSettings: 1,
    prompts: promptSeeds.length,
    modelAssignments: assignmentSeeds.length,
    user: userInserted,
  };
}

// ---------------------------------------------------------------------------
// CLI エントリポイント
// ---------------------------------------------------------------------------

// `tsx packages/db/seed.ts` で直接実行されたときのみ DB に接続する。
// import * as seed from './seed.js' の経路では副作用を起こさない。
async function isDirectRun(): Promise<boolean> {
  if (typeof process === 'undefined' || process.argv[1] === undefined) return false;
  const { fileURLToPath } = await import('node:url');
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (await isDirectRun()) {
  // Top-level await を避けるため即時関数で wrap。
  (async () => {
    const { prisma } = await import('./index.js');
    try {
      const result = await runSeed(prisma, process.env);
      console.log('[seed] DONE', result);
    } catch (err) {
      console.error('[seed] FAILED', err);
      process.exitCode = 1;
    } finally {
      await prisma.$disconnect();
    }
  })();
}
