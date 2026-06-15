import { describe, it, expect } from 'vitest';
import { buildDocx } from '../src/build-docx.js';
import JSZip from 'jszip';

const sampleBook = {
  title: 'テスト書籍タイトル',
  subtitle: 'サブタイトルの例',
};

const sampleChapters = [
  {
    index: 1,
    heading: '第1章 はじめに',
    body_md: [
      'これは第1章の本文です。AIを活用した出版の世界へようこそ。',
      '',
      '## セクション1.1',
      '',
      'ここではAI出版の基本について説明します。**太字テキスト**や*イタリック*も含みます。',
      '',
      '- リスト項目1',
      '- リスト項目2',
      '- リスト項目3',
      '',
      '> 引用テキストの例です。',
      '',
      '```',
      'コードブロックの例',
      '```',
    ].join('\n'),
  },
  {
    index: 2,
    heading: '第2章 実践編',
    body_md: [
      '第2章では実践的な内容を扱います。',
      '',
      '## セクション2.1',
      '',
      'ステップバイステップで進めましょう。[リンクテスト](https://example.com)も含めます。',
      '',
      '### サブセクション2.1.1',
      '',
      'さらに詳しい内容です。`インラインコード`もサポートしています。',
    ].join('\n'),
  },
  {
    index: 3,
    heading: '第3章 まとめ',
    body_md: [
      'これは最終章のまとめです。',
      '',
      '全体を振り返り、学んだことを整理しましょう。',
      '',
      '---',
      '',
      '本書は AI によって生成されました。',
    ].join('\n'),
  },
];

describe('buildDocx', () => {
  it('generates a valid zip (docx) buffer', async () => {
    const buffer = await buildDocx(sampleBook, sampleChapters);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(buffer);
    const entries = Object.keys(zip.files);

    expect(entries).toContain('[Content_Types].xml');
    expect(entries.some((e) => e.startsWith('word/'))).toBe(true);
    expect(entries.some((e) => e.includes('document.xml'))).toBe(true);
  });

  it('contains chapter headings as Heading1', async () => {
    const buffer = await buildDocx(sampleBook, sampleChapters);
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')!.async('text');

    for (const chapter of sampleChapters) {
      expect(documentXml).toContain(chapter.heading);
    }

    expect(documentXml).toContain('Heading1');
  });

  it('contains a Table of Contents section', async () => {
    const buffer = await buildDocx(sampleBook, sampleChapters);
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')!.async('text');

    expect(documentXml).toContain('TOC');
    expect(documentXml).toContain('目次');
  });

  it('contains the book title in the document', async () => {
    const buffer = await buildDocx(sampleBook, sampleChapters);
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')!.async('text');

    expect(documentXml).toContain(sampleBook.title);
    expect(documentXml).toContain(sampleBook.subtitle);
  });

  it('specifies Noto Sans JP font', async () => {
    const buffer = await buildDocx(sampleBook, sampleChapters);
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')!.async('text');

    expect(documentXml).toContain('Noto Sans JP');
  });

  it('handles markdown formatting in body text', async () => {
    const buffer = await buildDocx(sampleBook, sampleChapters);
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')!.async('text');

    expect(documentXml).toContain('太字テキスト');
    expect(documentXml).toContain('リスト項目1');
    expect(documentXml).toContain('コードブロックの例');
  });

  it('contains blockquote text in the document', async () => {
    const buffer = await buildDocx(sampleBook, sampleChapters);
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')!.async('text');

    expect(documentXml).toContain('引用テキストの例です');
  });

  it('contains hyperlinks in the document', async () => {
    const buffer = await buildDocx(sampleBook, sampleChapters);
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')!.async('text');

    expect(documentXml).toContain('リンクテスト');

    const relsFiles = Object.keys(zip.files).filter(
      (name) => name.includes('document.xml.rels'),
    );
    if (relsFiles.length > 0) {
      const relsXml = await zip.file(relsFiles[0]!)!.async('text');
      expect(relsXml).toContain('https://example.com');
    }
  });

  it('works without subtitle', async () => {
    const bookNoSub = { title: 'タイトルのみ' };
    const buffer = await buildDocx(bookNoSub, sampleChapters);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('sorts chapters by index', async () => {
    const reversed = [...sampleChapters].reverse();
    const buffer = await buildDocx(sampleBook, reversed);
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')!.async('text');

    const idx1 = documentXml.indexOf('第1章');
    const idx2 = documentXml.indexOf('第2章');
    const idx3 = documentXml.indexOf('第3章');
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });

  it('includes page numbers in footers', async () => {
    const buffer = await buildDocx(sampleBook, sampleChapters);
    const zip = await JSZip.loadAsync(buffer);

    const footerFiles = Object.keys(zip.files).filter(
      (name) => name.startsWith('word/footer') && name.endsWith('.xml'),
    );
    expect(footerFiles.length).toBeGreaterThan(0);

    const footerXml = await zip.file(footerFiles[0]!)!.async('text');
    expect(footerXml).toContain('PAGE');
  });

  it('includes styles definition with heading styles', async () => {
    const buffer = await buildDocx(sampleBook, sampleChapters);
    const zip = await JSZip.loadAsync(buffer);
    const stylesXml = await zip.file('word/styles.xml')!.async('text');

    expect(stylesXml).toContain('Heading1');
    expect(stylesXml).toContain('Heading2');
  });
});
