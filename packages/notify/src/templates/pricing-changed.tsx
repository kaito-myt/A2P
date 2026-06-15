import { EmailLayout, appUrl } from './_layout.js';
import { COMMON, PRICING_CHANGED } from './i18n.js';

/**
 * モデル単価が前日比 ±10% 変動した際の通知 (docs/03 §B-05, F-024 受入基準)。
 * 本実装は SP-02 で行う。本タスクでは枠 + 文言のみ。
 */

export interface PricingChangedEmailProps {
  model: string;
  oldUsdPerMtok: number;
  newUsdPerMtok: number;
  /** 正負含む変動率(%)。例: -12.5 / +15.0 */
  deltaPct: number;
}

export const PRICING_CHANGED_SUBJECT = PRICING_CHANGED.subject;

export function PricingChangedEmail(props: PricingChangedEmailProps) {
  const body = PRICING_CHANGED.body({
    model: props.model,
    oldUsdPerMtok: props.oldUsdPerMtok,
    newUsdPerMtok: props.newUsdPerMtok,
    deltaPct: props.deltaPct,
  });
  return (
    <EmailLayout
      preview={PRICING_CHANGED.subject}
      heading={PRICING_CHANGED.heading}
      paragraphs={body.split('\n')}
      cta={{ href: appUrl('/admin/model-catalog'), label: COMMON.ctaOpenModelCatalog }}
    />
  );
}

export function buildPricingChangedEmail(props: PricingChangedEmailProps) {
  return {
    subject: PRICING_CHANGED_SUBJECT,
    react: <PricingChangedEmail {...props} />,
  };
}
