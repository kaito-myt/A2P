import React from 'react';
import {
  Document,
  Page,
  Text,
  View,
  renderToBuffer,
  StyleSheet,
} from '@react-pdf/renderer';
import { markdownToReactPdfElements } from './md-to-react-pdf.js';
import { registerFonts, FONT_FAMILY } from './register-fonts.js';

const A5_WIDTH_PT = 419.53; // 148mm
const A5_HEIGHT_PT = 595.28; // 210mm

const styles = StyleSheet.create({
  page: {
    width: A5_WIDTH_PT,
    height: A5_HEIGHT_PT,
    paddingTop: 56.69, // 20mm
    paddingBottom: 56.69,
    paddingLeft: 42.52, // 15mm
    paddingRight: 42.52,
    fontFamily: FONT_FAMILY,
    fontSize: 10,
  },
  chapterTitlePage: {
    width: A5_WIDTH_PT,
    height: A5_HEIGHT_PT,
    paddingTop: 56.69,
    paddingBottom: 56.69,
    paddingLeft: 42.52,
    paddingRight: 42.52,
    fontFamily: FONT_FAMILY,
    justifyContent: 'center',
    alignItems: 'center',
  },
  chapterTitleText: {
    fontFamily: FONT_FAMILY,
    fontSize: 24,
    fontWeight: 700,
    textAlign: 'center',
  },
  bodyContainer: {
    flex: 1,
  },
  pageNumber: {
    position: 'absolute',
    bottom: 28,
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 9,
    fontFamily: FONT_FAMILY,
    color: '#666',
  },
});

export interface BuildPdfBook {
  title: string;
  subtitle?: string | null;
}

export interface BuildPdfChapter {
  index: number;
  heading: string;
  body_md: string;
}

function ChapterTitlePage({
  heading,
}: {
  heading: string;
}): React.ReactElement {
  return (
    <Page size={[A5_WIDTH_PT, A5_HEIGHT_PT]} style={styles.chapterTitlePage}>
      <Text style={styles.chapterTitleText}>{heading}</Text>
      <Text
        style={styles.pageNumber}
        render={({ pageNumber }) => `${pageNumber}`}
      />
    </Page>
  );
}

function ChapterBodyPages({
  bodyMd,
}: {
  bodyMd: string;
}): React.ReactElement {
  const bodyElements = markdownToReactPdfElements(bodyMd);

  return (
    <Page size={[A5_WIDTH_PT, A5_HEIGHT_PT]} style={styles.page} wrap>
      <View style={styles.bodyContainer}>{bodyElements}</View>
      <Text
        style={styles.pageNumber}
        render={({ pageNumber }) => `${pageNumber}`}
        fixed
      />
    </Page>
  );
}

export async function buildPdf(
  book: BuildPdfBook,
  chapters: BuildPdfChapter[],
): Promise<Buffer> {
  registerFonts();

  const sorted = [...chapters].sort((a, b) => a.index - b.index);

  const doc = (
    <Document
      title={book.title}
      author="A2P"
      subject={book.subtitle ?? undefined}
    >
      {sorted.map((ch) => (
        <React.Fragment key={`ch-${ch.index}`}>
          <ChapterTitlePage heading={ch.heading} />
          <ChapterBodyPages bodyMd={ch.body_md} />
        </React.Fragment>
      ))}
    </Document>
  );

  const buffer = await renderToBuffer(doc);
  return Buffer.from(buffer);
}
