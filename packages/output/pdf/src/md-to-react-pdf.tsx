import React from 'react';
import { Text, View, Link } from '@react-pdf/renderer';
import { marked, type Token, type Tokens } from 'marked';
import { FONT_FAMILY } from './register-fonts.js';

const BODY_SIZE = 10;
const LINE_HEIGHT = 1.8;

interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

function inlineToElements(
  tokens: Token[],
  inherited?: InlineStyle,
): React.ReactElement[] {
  const elements: React.ReactElement[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const key = `inline-${i}`;

    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text;
        if ('tokens' in t && t.tokens) {
          elements.push(
            ...inlineToElements(t.tokens, inherited).map((el, j) =>
              React.cloneElement(el, { key: `${key}-${j}` }),
            ),
          );
        } else {
          elements.push(
            <Text
              key={key}
              style={{
                fontFamily: FONT_FAMILY,
                fontSize: BODY_SIZE,
                fontWeight: inherited?.bold ? 700 : 400,
                fontStyle: inherited?.italic ? 'italic' : 'normal',
              }}
            >
              {t.text}
            </Text>,
          );
        }
        break;
      }
      case 'strong': {
        const t = token as Tokens.Strong;
        elements.push(
          ...inlineToElements(t.tokens, { ...inherited, bold: true }).map(
            (el, j) => React.cloneElement(el, { key: `${key}-${j}` }),
          ),
        );
        break;
      }
      case 'em': {
        const t = token as Tokens.Em;
        elements.push(
          ...inlineToElements(t.tokens, { ...inherited, italic: true }).map(
            (el, j) => React.cloneElement(el, { key: `${key}-${j}` }),
          ),
        );
        break;
      }
      case 'codespan': {
        const t = token as Tokens.Codespan;
        elements.push(
          <Text
            key={key}
            style={{
              fontFamily: 'Courier',
              fontSize: BODY_SIZE - 1,
              backgroundColor: '#f0f0f0',
            }}
          >
            {t.text}
          </Text>,
        );
        break;
      }
      case 'link': {
        const t = token as Tokens.Link;
        elements.push(
          <Link key={key} src={t.href} style={{ color: '#1a0dab' }}>
            <Text
              style={{
                fontFamily: FONT_FAMILY,
                fontSize: BODY_SIZE,
                textDecoration: 'underline',
              }}
            >
              {t.text}
            </Text>
          </Link>,
        );
        break;
      }
      case 'br': {
        elements.push(<Text key={key}>{'\n'}</Text>);
        break;
      }
      default: {
        if ('text' in token && typeof token.text === 'string') {
          elements.push(
            <Text
              key={key}
              style={{
                fontFamily: FONT_FAMILY,
                fontSize: BODY_SIZE,
                fontWeight: inherited?.bold ? 700 : 400,
              }}
            >
              {token.text}
            </Text>,
          );
        }
        break;
      }
    }
  }

  return elements;
}

export function markdownToReactPdfElements(
  md: string,
): React.ReactElement[] {
  const tokens = marked.lexer(md);
  return tokensToElements(tokens);
}

function tokensToElements(tokens: Token[]): React.ReactElement[] {
  const elements: React.ReactElement[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const key = `block-${i}`;

    switch (token.type) {
      case 'heading': {
        const t = token as Tokens.Heading;
        const fontSize =
          t.depth === 1 ? 18 : t.depth === 2 ? 14 : 12;
        const marginTop =
          t.depth === 1 ? 24 : t.depth === 2 ? 18 : 12;
        elements.push(
          <View key={key} style={{ marginTop, marginBottom: 8 }}>
            <Text
              style={{
                fontFamily: FONT_FAMILY,
                fontSize,
                fontWeight: 700,
                lineHeight: LINE_HEIGHT,
              }}
            >
              {t.text}
            </Text>
          </View>,
        );
        break;
      }
      case 'paragraph': {
        const t = token as Tokens.Paragraph;
        elements.push(
          <View key={key} style={{ marginBottom: 8 }}>
            <Text style={{ lineHeight: LINE_HEIGHT }}>
              {inlineToElements(t.tokens)}
            </Text>
          </View>,
        );
        break;
      }
      case 'list': {
        const t = token as Tokens.List;
        elements.push(
          <View key={key} style={{ marginBottom: 8, paddingLeft: 16 }}>
            {t.items.map((item, idx) => {
              const bullet = t.ordered ? `${idx + 1}. ` : '• ';
              const inlineTokens = item.tokens
                ? item.tokens.flatMap((sub) =>
                    'tokens' in sub && Array.isArray(sub.tokens)
                      ? sub.tokens
                      : [sub],
                  )
                : [];
              return (
                <View
                  key={`${key}-item-${idx}`}
                  style={{
                    flexDirection: 'row',
                    marginBottom: 4,
                  }}
                >
                  <Text
                    style={{
                      fontFamily: FONT_FAMILY,
                      fontSize: BODY_SIZE,
                      width: 16,
                    }}
                  >
                    {bullet}
                  </Text>
                  <Text
                    style={{
                      flex: 1,
                      lineHeight: LINE_HEIGHT,
                    }}
                  >
                    {inlineToElements(inlineTokens)}
                  </Text>
                </View>
              );
            })}
          </View>,
        );
        break;
      }
      case 'code': {
        const t = token as Tokens.Code;
        elements.push(
          <View
            key={key}
            style={{
              backgroundColor: '#f5f5f5',
              padding: 8,
              marginBottom: 8,
              marginLeft: 16,
            }}
          >
            {t.text.split('\n').map((line, idx) => (
              <Text
                key={`${key}-line-${idx}`}
                style={{
                  fontFamily: 'Courier',
                  fontSize: BODY_SIZE - 1,
                  lineHeight: 1.5,
                }}
              >
                {line}
              </Text>
            ))}
          </View>,
        );
        break;
      }
      case 'blockquote': {
        const t = token as Tokens.Blockquote;
        elements.push(
          <View
            key={key}
            style={{
              borderLeftWidth: 3,
              borderLeftColor: '#ccc',
              paddingLeft: 12,
              marginBottom: 8,
              marginLeft: 8,
            }}
          >
            {tokensToElements(t.tokens).map((el, j) =>
              React.cloneElement(el, { key: `${key}-bq-${j}` }),
            )}
          </View>,
        );
        break;
      }
      case 'hr': {
        elements.push(
          <View
            key={key}
            style={{
              borderBottomWidth: 1,
              borderBottomColor: '#ccc',
              marginTop: 16,
              marginBottom: 16,
            }}
          />,
        );
        break;
      }
      case 'space': {
        break;
      }
      default: {
        if ('text' in token && typeof token.text === 'string') {
          elements.push(
            <View key={key} style={{ marginBottom: 8 }}>
              <Text
                style={{
                  fontFamily: FONT_FAMILY,
                  fontSize: BODY_SIZE,
                  lineHeight: LINE_HEIGHT,
                }}
              >
                {token.text}
              </Text>
            </View>,
          );
        }
        break;
      }
    }
  }

  return elements;
}
