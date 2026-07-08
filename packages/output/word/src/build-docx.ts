import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Footer,
  PageNumber,
  NumberFormat,
  Header,
  type ISectionOptions,
} from 'docx';
import { markdownToDocxElements } from './md-to-docx.js';

const FONT = 'Noto Sans JP';

export interface BuildDocxBook {
  title: string;
  subtitle?: string | null;
}

export interface BuildDocxChapter {
  index: number;
  heading: string;
  body_md: string;
}

export async function buildDocx(
  book: BuildDocxBook,
  chapters: BuildDocxChapter[],
): Promise<Buffer> {
  const sorted = [...chapters].sort((a, b) => a.index - b.index);

  const titleSection = buildTitleSection(book);
  const tocSection = buildTocSection(sorted);
  const chapterSections = sorted.map((ch) => buildChapterSection(ch));

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: FONT,
            size: 22,
          },
        },
        heading1: {
          run: {
            font: FONT,
            size: 36,
            bold: true,
          },
          paragraph: {
            spacing: { before: 480, after: 240 },
          },
        },
        heading2: {
          run: {
            font: FONT,
            size: 28,
            bold: true,
          },
          paragraph: {
            spacing: { before: 360, after: 120 },
          },
        },
        heading3: {
          run: {
            font: FONT,
            size: 24,
            bold: true,
          },
          paragraph: {
            spacing: { before: 240, after: 120 },
          },
        },
      },
    },
    features: {
      updateFields: true,
    },
    sections: [titleSection, tocSection, ...chapterSections],
  });

  const buffer = await Packer.toBuffer(doc);
  return Buffer.from(buffer);
}

function buildTitleSection(book: BuildDocxBook): ISectionOptions {
  const children: Paragraph[] = [
    new Paragraph({
      children: [],
      spacing: { before: 3000 },
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: book.title,
          font: FONT,
          size: 56,
          bold: true,
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    }),
  ];

  if (book.subtitle) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: book.subtitle,
            font: FONT,
            size: 32,
          }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: { after: 600 },
      }),
    );
  }

  return {
    properties: {
      page: {
        pageNumbers: { start: 1, formatType: NumberFormat.LOWER_ROMAN },
      },
    },
    children,
  };
}

function buildTocSection(chapters: BuildDocxChapter[]): ISectionOptions {
  // Word の TableOfContents フィールドは開いて「フィールド更新」するまで空表示に
  // なるため、章見出しを静的に列挙して確実に目次が見えるようにする (PDF と同形)。
  const tocEntries = chapters.map(
    (ch) =>
      new Paragraph({
        children: [
          new TextRun({
            // heading は呼出側 (export タスク) で正規化済のタイトル行
            // (「第1章　…」「はじめに——…」)。ここで章番号を前置しない (二重番号防止)。
            text: ch.heading,
            font: FONT,
            size: 22,
          }),
        ],
        spacing: { after: 160 },
      }),
  );

  return {
    properties: {
      page: {
        pageNumbers: { start: 1, formatType: NumberFormat.LOWER_ROMAN },
      },
    },
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text: '目次',
            font: FONT,
            size: 36,
            bold: true,
          }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: { after: 400 },
      }),
      ...tocEntries,
    ],
  };
}

function buildChapterSection(chapter: BuildDocxChapter): ISectionOptions {
  const bodyElements = markdownToDocxElements(chapter.body_md);

  const heading = new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [
      new TextRun({
        text: chapter.heading,
        font: FONT,
        size: 36,
        bold: true,
      }),
    ],
    spacing: { before: 480, after: 240 },
  });

  return {
    properties: {
      page: {
        pageNumbers: {
          start: chapter.index === 1 ? 1 : undefined,
          formatType: chapter.index === 1 ? NumberFormat.DECIMAL : undefined,
        },
      },
    },
    headers: {
      default: new Header({
        children: [
          new Paragraph({
            children: [
              new TextRun({
                text: chapter.heading,
                font: FONT,
                size: 18,
                italics: true,
              }),
            ],
            alignment: AlignmentType.RIGHT,
          }),
        ],
      }),
    },
    footers: {
      default: new Footer({
        children: [
          new Paragraph({
            children: [
              new TextRun({
                children: [PageNumber.CURRENT],
                font: FONT,
                size: 18,
              }),
            ],
            alignment: AlignmentType.CENTER,
          }),
        ],
      }),
    },
    children: [heading, ...bodyElements],
  };
}
