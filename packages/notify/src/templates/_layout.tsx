import type { ReactNode } from 'react';

import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';

import { COMMON } from './i18n.js';

/**
 * 全テンプレ共通の最小レイアウト。
 * cream/charcoal カラーは docs/04 §6.3 の最終トークンと厳密一致させず、
 * メールクライアント互換のため固定 16 進で記述する（メールでは Tailwind は使えない）。
 */

export interface EmailLayoutProps {
  preview: string;
  heading: string;
  paragraphs: string[];
  cta?: {
    href: string;
    label: string;
  };
  children?: ReactNode;
}

const styles = {
  body: { backgroundColor: '#f7f4ed', margin: 0, padding: '24px 0', fontFamily: 'sans-serif' },
  container: {
    backgroundColor: '#fcfbf8',
    border: '1px solid #eceae4',
    borderRadius: '12px',
    margin: '0 auto',
    maxWidth: '560px',
    padding: '32px',
  },
  heading: { color: '#1c1c1c', fontSize: '20px', margin: '0 0 16px', fontWeight: 600 },
  paragraph: { color: '#1c1c1c', fontSize: '14px', lineHeight: '1.7', margin: '0 0 12px', whiteSpace: 'pre-wrap' as const },
  hr: { borderColor: '#eceae4', margin: '24px 0' },
  button: {
    backgroundColor: '#1c1c1c',
    borderRadius: '8px',
    color: '#fcfbf8',
    display: 'inline-block',
    fontSize: '14px',
    fontWeight: 600,
    padding: '12px 20px',
    textDecoration: 'none',
  },
  footer: { color: '#5f5f5d', fontSize: '12px', margin: '24px 0 0' },
};

export function EmailLayout({ preview, heading, paragraphs, cta, children }: EmailLayoutProps) {
  return (
    <Html lang="ja">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Heading style={styles.heading}>{heading}</Heading>
          <Section>
            {paragraphs.map((p, i) => (
              <Text key={i} style={styles.paragraph}>
                {p}
              </Text>
            ))}
          </Section>
          {children}
          {cta ? (
            <Section style={{ margin: '20px 0 0' }}>
              <Button href={cta.href} style={styles.button}>
                {cta.label}
              </Button>
            </Section>
          ) : null}
          <Hr style={styles.hr} />
          <Text style={styles.footer}>{COMMON.footerSignature}</Text>
        </Container>
      </Body>
    </Html>
  );
}

/** `NEXT_PUBLIC_APP_URL` を起点に絶対 URL を組み立てる。未設定なら相対のまま返す。 */
export function appUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? '';
  if (!base) return path;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}
