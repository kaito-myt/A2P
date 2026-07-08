/**
 * Sidebar navigation hierarchy — docs/04 §3.3 の完全コピー。
 *
 * Phase 1 で未実装の画面は `enabled: false`。リンクは sidebar 側で disabled 描画。
 * 文言は `lib/messages.ts` に集約。
 */
import { messages } from '@/lib/messages';

export interface NavItem {
  key: string;
  label: string;
  href: string;
  enabled: boolean;
  /** true の場合は別タブ (target="_blank") で開く。 */
  external?: boolean;
}

export interface NavSection {
  key: string;
  label: string;
  items: NavItem[];
}

const m = messages.nav;

export const navSections: readonly NavSection[] = [
  {
    key: 'home',
    label: m.sectionHome,
    items: [
      { key: 'home', label: m.itemHome, href: '/dashboard', enabled: true },
      { key: 'help', label: m.itemHelp, href: '/help', enabled: true, external: true },
    ],
  },
  {
    key: 'pipeline',
    label: m.sectionPipeline,
    items: [
      { key: 'themes', label: m.itemThemes, href: '/themes', enabled: true },
      { key: 'batch', label: m.itemBatchPlan, href: '/batches', enabled: true },
      { key: 'outlines', label: m.itemOutlines, href: '/outlines', enabled: true },
      { key: 'content-review', label: m.itemContentReview, href: '/content-review', enabled: true },
      { key: 'thumbnails', label: m.itemThumbnails, href: '/covers', enabled: true },
      { key: 'kdp', label: m.itemKdpChecklist, href: '/kdp/checklist', enabled: true },
    ],
  },
  {
    key: 'books',
    label: m.sectionBooks,
    items: [
      { key: 'library', label: m.itemBookLibrary, href: '/books', enabled: true },
      { key: 'comments', label: m.itemComments, href: '/comments', enabled: true },
      { key: 'revisionRuns', label: m.itemRevisionRuns, href: '/revision-runs', enabled: true },
    ],
  },
  {
    key: 'promotion',
    label: m.sectionPromotion,
    items: [
      { key: 'promotion', label: m.itemPromotion, href: '/promotion', enabled: true },
      { key: 'promotion-x', label: m.itemPromotionX, href: '/promotion/channel/x', enabled: true },
      { key: 'promotion-instagram', label: m.itemPromotionInstagram, href: '/promotion/channel/instagram', enabled: true },
      { key: 'promotion-tiktok', label: m.itemPromotionTiktok, href: '/promotion/channel/tiktok', enabled: true },
      { key: 'promotion-note', label: m.itemPromotionNote, href: '/promotion/channel/note', enabled: true },
      { key: 'promotion-blog', label: m.itemPromotionBlog, href: '/promotion/channel/blog', enabled: true },
    ],
  },
  {
    key: 'analytics',
    label: m.sectionAnalytics,
    items: [
      { key: 'sales', label: m.itemSalesKpi, href: '/sales', enabled: true },
      { key: 'cost', label: m.itemCostDetail, href: '/cost', enabled: true },
    ],
  },
  {
    key: 'models',
    label: m.sectionModels,
    items: [
      { key: 'model-assignment', label: m.itemModelAssignment, href: '/models/assignments', enabled: true },
      { key: 'model-catalog', label: m.itemModelCatalog, href: '/models/catalog', enabled: true },
      { key: 'ab-compare', label: m.itemAbCompare, href: '/models/ab', enabled: true },
      { key: 'bakeoff', label: m.itemBakeoff, href: '/models/bakeoff', enabled: true },
      { key: 'prompts', label: m.itemPromptManage, href: '/prompts', enabled: true },
      { key: 'prompt-approval', label: m.itemPromptApproval, href: '/prompts/proposals', enabled: true },
    ],
  },
  {
    key: 'ops',
    label: m.sectionOps,
    items: [
      { key: 'jobs', label: m.itemJobLogs, href: '/jobs', enabled: true },
      { key: 'alerts', label: m.itemAlerts, href: '/alerts', enabled: true },
      { key: 'kdp-auto', label: m.itemKdpAutoSubmit, href: '/kdp/auto', enabled: false },
      { key: 'audit', label: m.itemAuditLog, href: '/audit', enabled: true },
      { key: 'accounts', label: m.itemAccounts, href: '/accounts', enabled: true },
      { key: 'masters', label: m.itemMasters, href: '/masters', enabled: true },
      { key: 'settings', label: m.itemSettings, href: '/settings', enabled: true },
    ],
  },
];
