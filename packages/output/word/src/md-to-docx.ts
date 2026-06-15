import {
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  type IParagraphOptions,
  type ParagraphChild,
  ExternalHyperlink,
} from 'docx';
import { marked, type Token, type Tokens } from 'marked';

const FONT = 'Noto Sans JP';
const BODY_SIZE = 22; // 11pt in half-points

function textRun(text: string, opts?: { bold?: boolean; italic?: boolean; font?: string; size?: number }): TextRun {
  return new TextRun({
    text,
    bold: opts?.bold,
    italics: opts?.italic,
    font: opts?.font ?? FONT,
    size: opts?.size ?? BODY_SIZE,
  });
}

function flattenInlineTokens(
  tokens: Token[],
  inherited?: { bold?: boolean; italic?: boolean },
): (TextRun | ExternalHyperlink)[] {
  const runs: (TextRun | ExternalHyperlink)[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text;
        if ('tokens' in t && t.tokens) {
          runs.push(...flattenInlineTokens(t.tokens, inherited));
        } else {
          runs.push(textRun(t.text, inherited));
        }
        break;
      }
      case 'strong': {
        const t = token as Tokens.Strong;
        runs.push(...flattenInlineTokens(t.tokens, { ...inherited, bold: true }));
        break;
      }
      case 'em': {
        const t = token as Tokens.Em;
        runs.push(...flattenInlineTokens(t.tokens, { ...inherited, italic: true }));
        break;
      }
      case 'codespan': {
        const t = token as Tokens.Codespan;
        runs.push(
          new TextRun({
            text: t.text,
            font: 'Courier New',
            size: BODY_SIZE,
            bold: inherited?.bold,
            italics: inherited?.italic,
          }),
        );
        break;
      }
      case 'link': {
        const t = token as Tokens.Link;
        runs.push(
          new ExternalHyperlink({
            children: [
              new TextRun({
                text: t.text,
                font: FONT,
                size: BODY_SIZE,
                style: 'Hyperlink',
              }),
            ],
            link: t.href,
          }),
        );
        break;
      }
      case 'br': {
        runs.push(new TextRun({ text: '', break: 1 }));
        break;
      }
      default: {
        if ('text' in token && typeof token.text === 'string') {
          runs.push(textRun(token.text, inherited));
        }
        break;
      }
    }
  }
  return runs;
}

function inlineTokensToParagraph(
  tokens: Token[],
  opts?: Partial<IParagraphOptions>,
): Paragraph {
  const children = flattenInlineTokens(tokens);
  return new Paragraph({ ...opts, children });
}

export function markdownToDocxElements(md: string): Paragraph[] {
  const tokens = marked.lexer(md);
  return tokensToElements(tokens);
}

function tokensToElements(tokens: Token[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const t = token as Tokens.Heading;
        const level =
          t.depth === 1
            ? HeadingLevel.HEADING_2
            : t.depth === 2
              ? HeadingLevel.HEADING_3
              : HeadingLevel.HEADING_4;
        paragraphs.push(
          new Paragraph({
            heading: level,
            children: flattenInlineTokens(t.tokens) as ParagraphChild[],
          }),
        );
        break;
      }
      case 'paragraph': {
        const t = token as Tokens.Paragraph;
        paragraphs.push(inlineTokensToParagraph(t.tokens));
        break;
      }
      case 'list': {
        const t = token as Tokens.List;
        for (const item of t.items) {
          const children = item.tokens
            ? flattenInlineTokens(
                item.tokens.flatMap((sub) =>
                  'tokens' in sub && Array.isArray(sub.tokens) ? sub.tokens : [sub],
                ),
              )
            : [textRun(item.text)];
          paragraphs.push(
            new Paragraph({
              children: children as ParagraphChild[],
              bullet: { level: 0 },
            }),
          );
        }
        break;
      }
      case 'code': {
        const t = token as Tokens.Code;
        for (const line of t.text.split('\n')) {
          paragraphs.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: line,
                  font: 'Courier New',
                  size: BODY_SIZE,
                }),
              ],
              indent: { left: 720 },
            }),
          );
        }
        break;
      }
      case 'blockquote': {
        const t = token as Tokens.Blockquote;
        for (const innerToken of t.tokens) {
          if (innerToken.type === 'paragraph') {
            const pt = innerToken as Tokens.Paragraph;
            paragraphs.push(inlineTokensToParagraph(pt.tokens, {
              indent: { left: 720 },
              alignment: AlignmentType.LEFT,
            }));
          } else {
            const nested = tokensToElements([innerToken]);
            paragraphs.push(...nested);
          }
        }
        break;
      }
      case 'hr': {
        paragraphs.push(
          new Paragraph({
            children: [textRun('---')],
            alignment: AlignmentType.CENTER,
          }),
        );
        break;
      }
      case 'space': {
        break;
      }
      default: {
        if ('text' in token && typeof token.text === 'string') {
          paragraphs.push(new Paragraph({ children: [textRun(token.text)] }));
        }
        break;
      }
    }
  }

  return paragraphs;
}
