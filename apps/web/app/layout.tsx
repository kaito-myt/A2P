import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { inter, notoJp } from '@a2p/ui/fonts';
import { messages } from '@/lib/messages';
import './globals.css';

export const metadata: Metadata = {
  title: messages.brand.appName,
  description: messages.brand.tagline,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja" className={`${inter.variable} ${notoJp.variable}`}>
      <body className="font-sans">{children}</body>
    </html>
  );
}
