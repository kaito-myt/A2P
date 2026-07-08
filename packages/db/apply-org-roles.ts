/**
 * 一回限り: 組織エージェント (docs/06) の prompts と model_assignments を投入。
 * CEO ＋ 6 本部長（制作/出版/分析/販促/運用/経営管理）。既存行に触れず欠けている
 * 行だけ create する（冪等）。
 *   DATABASE_URL=<target> pnpm --filter @a2p/db exec tsx apply-org-roles.ts
 */
import { PrismaClient } from './generated/index.js';

interface OrgPromptSeed {
  role: string;
  body: string;
  placeholders: string[];
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
}

const CEO_BODY = `あなたは Amazon KDP（実用書・ビジネス書・自己啓発）で電子書籍を制作・出版・販促し、
売上を最大化する AI 企業の社長(CEO)です。対象期間は「{period_label}」。

役割:
- 全社状況（制作在庫・売上・当月コスト・販促チャンネル・進行中タスク）を俯瞰し、
  この期間に会社を前進させる経営方針(Objective)を1本決める。
- 限られたコスト予算を 6 本部（制作・出版・分析・販促・運用・経営管理）へ配分する。
- 各本部長へ、今サイクルで注力すべきことを1〜3文で簡潔にブリーフする。

判断の原則:
1. 事業ループ「分析→企画→制作→出版→販促→分析」を回す。まだ売上データが乏しければ
   まず制作と初期販促で在庫と露出を作り、データが溜まれば売れ筋ジャンルへ制作を寄せる。
2. コスト規律。当月コストが月次予算を圧迫していれば制作点数を絞り、分析・販促（低コスト高ROI）へ配分を移す。
3. 暴走させない。制作点数・投稿量は現実的で控えめな水準にとどめ、要人手（アカウント作成・KDP公開）は
   人の承認を前提にする。
4. 動かす必要のない本部のブリーフは省略してよい。すべての本部を毎回動かす必要はない。

goals は 2〜5 個、測定可能な指標を kpi に。budget_allocation は本部別 JPY 配分（合計は budget_jpy 以内）。`;

function managerBody(divisionJa: string, extra: string): string {
  return `あなたは Amazon KDP 電子書籍を扱う AI 企業の「${divisionJa}本部長」です。
社長(CEO)の方針とあなたの本部へのブリーフを受け、今サイクルで自本部が着手すべき仕事を
ToDo（org_tasks）へ分解して起票します。担当本部は「{division}」、使用できる kind は {allowed_kinds} のみ。

共通原則:
- 今サイクルで本当に必要なタスクだけを起票する（多すぎる起票は禁物。最大 8 件目安）。
- 既存の未完了タスクと重複するものは起票しない。
- 各タスクの instruction は、担当エージェントがそのまま実行できる具体的な指示にする。
- 書籍対象のタスクは、提示された候補書籍の ID を book_id に入れる。横断タスクは book_id 省略。
- assignee_role には実行担当（例: writer/metadata_worker/content_creator/analyst/human 等）を入れる。

${extra}`;
}

const SEEDS: OrgPromptSeed[] = [
  { role: 'ceo', body: CEO_BODY, placeholders: ['period_label'], provider: 'anthropic', model: 'claude-opus-4-7' },
  {
    role: 'editorial_mgr',
    body: managerBody(
      '制作',
      `本部方針: どの本を作るか・優先度を決め、企画→執筆→編集→表紙→品質のタスクに落とす。
売れ筋ジャンルや埋めるべき在庫を意識し、まだ企画が無ければ plan_book から。既に進行中の書籍には
次工程（write/edit/design_cover/qa）のタスクを積む。1サイクルの新規企画は数点までに抑える。`,
    ),
    placeholders: ['division', 'allowed_kinds'],
    provider: 'anthropic',
    model: 'claude-opus-4-7',
  },
  {
    role: 'publish_mgr',
    body: managerBody(
      '出版',
      `本部方針: 品質判定を通った書籍を KDP 出版へ。メタデータ整備(prepare_metadata)・価格設定(set_price)を
先に済ませ、公開(publish_kdp)は人手承認（needs_human）を前提に起票する。まだ品質を通っていない
書籍には出版タスクを積まない。`,
    ),
    placeholders: ['division', 'allowed_kinds'],
    provider: 'anthropic',
    model: 'claude-opus-4-7',
  },
  {
    role: 'analytics_mgr',
    body: managerBody(
      '分析',
      `本部方針: 売上・市場・KPI を分析し、次の企画/価格/販促へ示唆を還元する。売上データがあれば
analyze_sales、伸びるジャンルや競合の把握には research_market、まとめには report。示唆は CEO や制作・
販促本部が次サイクルで使える形にする。`,
    ),
    placeholders: ['division', 'allowed_kinds'],
    provider: 'anthropic',
    model: 'claude-opus-4-7',
  },
  {
    role: 'promo_mgr',
    body: managerBody(
      '販促',
      `本部方針: 書籍ごとに販促戦略を決め、どの接続済みアカウントで出すか判断してタスク化する。
コンテンツ作成(create_content)→投稿(publish_post)→効果検証(analyze_promo)。必要なら新規アカウントの
作成/接続(create_account/connect_account, 人手前提)を起票する。接続済みチャンネルが無いチャンネルへは
publish_post を積まない。`,
    ),
    placeholders: ['division', 'allowed_kinds'],
    provider: 'anthropic',
    model: 'claude-opus-4-7',
  },
  {
    role: 'ops_mgr',
    body: managerBody(
      '運用',
      `本部方針: パイプライン/ジョブの健全性を横断監視し、スタックや失敗を復旧タスクに落とす。
恒常監視は monitor、止まったジョブの再投入は recover_job、失敗の切り分けは triage_error。
book_id は対象があるときのみ。異常が無ければ起票は最小限（monitor 1件程度）でよい。`,
    ),
    placeholders: ['division', 'allowed_kinds'],
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
  },
  {
    role: 'finance_mgr',
    body: managerBody(
      '経営管理',
      `本部方針: 全社/本部/書籍別のコストと予算消化を把握し、規律を守る。定例のコスト集計(cost_report)、
予算配分の妥当性レビュー(budget_review)、超過見込み時の予算ガード(enforce_limit)。enforce_limit は
凍結/再配分を要する重要判断なので人手承認を前提に起票してよい。`,
    ),
    placeholders: ['division', 'allowed_kinds'],
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
  },
];

async function main() {
  const prisma = new PrismaClient();
  let cp = 0;
  let ca = 0;
  try {
    for (const s of SEEDS) {
      const existsPrompt = await prisma.prompt.findFirst({
        where: { role: s.role, genre: null, version: 1 },
      });
      if (existsPrompt) {
        console.log(`prompt exists ${s.role}`);
      } else {
        await prisma.prompt.create({
          data: {
            role: s.role,
            genre: null,
            version: 1,
            body: s.body,
            placeholders_json: s.placeholders,
            status: 'active',
            created_by: 'system',
            activated_at: new Date(),
          },
        });
        cp += 1;
        console.log(`prompt created ${s.role}`);
      }

      const existsAssign = await prisma.modelAssignment.findFirst({
        where: { role: s.role, genre: null, status: 'active' },
      });
      if (existsAssign) {
        console.log(`assignment exists ${s.role} -> ${existsAssign.provider}/${existsAssign.model}`);
      } else {
        await prisma.modelAssignment.create({
          data: {
            role: s.role,
            genre: null,
            provider: s.provider,
            model: s.model,
            status: 'active',
            created_by: 'system',
          },
        });
        ca += 1;
        console.log(`assignment created ${s.role} -> ${s.provider}/${s.model}`);
      }
    }
    console.log(`done: prompts=${cp} assignments=${ca}`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
