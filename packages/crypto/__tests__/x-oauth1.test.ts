import { describe, expect, it } from 'vitest';

import {
  buildXOAuth1Header,
  buildXAuthHeader,
  buildOAuth1BaseString,
  computeOAuth1Signature,
  parseXCredentials,
  serializeXOAuth1,
  percentEncode,
  type XOAuth1Credentials,
} from '../src/x-oauth1.js';

/**
 * Twitter 公式ドキュメント "Creating a signature" のテストベクタ。
 * https://developer.twitter.com/en/docs/authentication/oauth-1-0a/creating-a-signature
 *
 * NOTE: 公式ページに印字された署名 `hCtSmYh+iHYCEqBWrE7C7hYmtUk=` は、同ページの
 * 署名ベース文字列と鍵に対して実際には HMAC が一致しない **既知の doc errata**。
 * ベース文字列(構築の難所)は公式と1文字違わず一致することを `expectedBaseString` で検証し、
 * 署名は当該ベース文字列＋鍵に対する正しい HMAC-SHA1 値を用いる。
 */
const VECTOR = {
  method: 'POST',
  url: 'https://api.twitter.com/1.1/statuses/update.json',
  creds: {
    kind: 'oauth1' as const,
    apiKey: 'xvz1evFS4wEEPTGEFPHBog',
    apiSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Y7',
    accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    accessTokenSecret: 'LswwdoUaIVS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
  } satisfies XOAuth1Credentials,
  nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
  timestamp: 1318622958,
  extraParams: {
    status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
    include_entities: 'true',
  },
  // 公式ドキュメント記載のベース文字列 (1文字違わず一致すべき)。
  expectedBaseString:
    'POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&' +
    'include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26' +
    'oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26' +
    'oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26' +
    'oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26' +
    'oauth_version%3D1.0%26' +
    'status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521',
  // 上記ベース文字列＋鍵に対する正しい HMAC-SHA1 (base64)。
  expectedSignature: '6NMqKSCvNLGkXsCRrU3yV2AdYfE=',
};

describe('percentEncode', () => {
  it('RFC3986: エンコードされない文字と特殊文字を正しく処理', () => {
    expect(percentEncode('Ladies + Gentlemen')).toBe('Ladies%20%2B%20Gentlemen');
    expect(percentEncode("!*'()")).toBe('%21%2A%27%28%29');
    expect(percentEncode('aA1-._~')).toBe('aA1-._~');
  });
});

describe('buildXOAuth1Header — 公式テストベクタ', () => {
  it('署名ベース文字列が公式ドキュメントと1文字違わず一致する', () => {
    const allParams = {
      oauth_consumer_key: VECTOR.creds.apiKey,
      oauth_nonce: VECTOR.nonce,
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: String(VECTOR.timestamp),
      oauth_token: VECTOR.creds.accessToken,
      oauth_version: '1.0',
      ...VECTOR.extraParams,
    };
    const base = buildOAuth1BaseString(VECTOR.method, VECTOR.url, allParams);
    expect(base).toBe(VECTOR.expectedBaseString);
  });

  it('署名が正しい HMAC-SHA1 値と一致する', () => {
    const { baseString, signature } = computeOAuth1Signature(VECTOR.method, VECTOR.url, VECTOR.creds, {
      nonce: VECTOR.nonce,
      timestamp: VECTOR.timestamp,
      extraParams: VECTOR.extraParams,
    });
    expect(baseString).toBe(VECTOR.expectedBaseString);
    expect(signature).toBe(VECTOR.expectedSignature);
  });

  it('ヘッダの oauth_signature が署名と一致する', () => {
    const header = buildXOAuth1Header(VECTOR.method, VECTOR.url, VECTOR.creds, {
      nonce: VECTOR.nonce,
      timestamp: VECTOR.timestamp,
      extraParams: VECTOR.extraParams,
    });
    const match = header.match(/oauth_signature="([^"]+)"/);
    expect(match).not.toBeNull();
    expect(decodeURIComponent(match![1]!)).toBe(VECTOR.expectedSignature);
  });

  it('ヘッダに必須の oauth_* フィールドが全て含まれる', () => {
    const header = buildXOAuth1Header('POST', 'https://api.twitter.com/2/tweets', VECTOR.creds, {
      nonce: 'n', timestamp: 1,
    });
    expect(header.startsWith('OAuth ')).toBe(true);
    for (const f of [
      'oauth_consumer_key', 'oauth_nonce', 'oauth_signature_method',
      'oauth_timestamp', 'oauth_token', 'oauth_version', 'oauth_signature',
    ]) {
      expect(header).toContain(`${f}=`);
    }
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
  });
});

describe('parseXCredentials', () => {
  it('OAuth1 の JSON を解釈する', () => {
    const json = serializeXOAuth1({
      apiKey: 'k', apiSecret: 's', accessToken: 'at', accessTokenSecret: 'ats',
    });
    const parsed = parseXCredentials(json);
    expect(parsed).toEqual({ kind: 'oauth1', apiKey: 'k', apiSecret: 's', accessToken: 'at', accessTokenSecret: 'ats' });
  });

  it('非 JSON 文字列は Bearer 扱い', () => {
    expect(parseXCredentials('AAAA-bearer-token')).toEqual({ kind: 'bearer', token: 'AAAA-bearer-token' });
  });

  it('空/欠損フィールドの JSON は null', () => {
    expect(parseXCredentials(null)).toBeNull();
    expect(parseXCredentials('')).toBeNull();
    expect(parseXCredentials('{"kind":"oauth1","apiKey":"k"}')).toBeNull();
    expect(parseXCredentials('{bad json')).toBeNull();
  });
});

describe('buildXAuthHeader', () => {
  it('bearer は Bearer ヘッダ', () => {
    expect(buildXAuthHeader('GET', 'https://x/y', { kind: 'bearer', token: 'T' })).toBe('Bearer T');
  });
  it('oauth1 は OAuth 署名ヘッダ', () => {
    const h = buildXAuthHeader('GET', 'https://api.twitter.com/2/users/me', VECTOR.creds, { nonce: 'n', timestamp: 1 });
    expect(h.startsWith('OAuth ')).toBe(true);
  });
});
