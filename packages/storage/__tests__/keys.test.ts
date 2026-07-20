import { describe, expect, it } from 'vitest';

import { ValidationError } from '@a2p/contracts/errors';

import {
  accountAvatar,
  channelAvatar,
  channelBanner,
  bookPromoImage,
  promotionPostImage,
  bookArtifact,
  catalogSnapshot,
  chapterDraft,
  dbBackup,
  jobsArchive,
  kdpScreenshot,
  softDeletedKey,
} from '../src/keys.js';

const BOOK_ID = 'clxyz0000abcd0000efgh0000';
const ACCOUNT_ID = 'cla1b2c3d4e5f6g7h8';
const COVER_ID = 'cov-001-zzz';
const JOB_ID = 'job_42abc';

describe('bookArtifact', () => {
  it('docx は manuscript/final.docx を返す', () => {
    expect(bookArtifact(BOOK_ID, 'docx')).toBe(`books/${BOOK_ID}/manuscript/final.docx`);
  });

  it('pdf は manuscript/final.pdf を返す', () => {
    expect(bookArtifact(BOOK_ID, 'pdf')).toBe(`books/${BOOK_ID}/manuscript/final.pdf`);
  });

  it('cover_source は covers/raw/<filename>', () => {
    expect(bookArtifact(BOOK_ID, 'cover_source', `${COVER_ID}.png`)).toBe(
      `books/${BOOK_ID}/covers/raw/${COVER_ID}.png`,
    );
  });

  it('cover_png は covers/kdp/<filename>', () => {
    expect(bookArtifact(BOOK_ID, 'cover_png', `${COVER_ID}-2560x1600.png`)).toBe(
      `books/${BOOK_ID}/covers/kdp/${COVER_ID}-2560x1600.png`,
    );
  });

  it('cover_source で filename を省略すると ValidationError', () => {
    expect(() => bookArtifact(BOOK_ID, 'cover_source')).toThrow(ValidationError);
  });

  it('cover_png で filename を省略すると ValidationError', () => {
    expect(() => bookArtifact(BOOK_ID, 'cover_png')).toThrow(ValidationError);
  });

  it('不正な bookId (空白) は ValidationError', () => {
    expect(() => bookArtifact('not valid', 'docx')).toThrow(ValidationError);
  });

  it('不正な bookId (全角) は ValidationError', () => {
    expect(() => bookArtifact('ＡＢＣ', 'docx')).toThrow(ValidationError);
  });

  it('不正な bookId (パストラバーサル) は ValidationError', () => {
    expect(() => bookArtifact('../etc/passwd', 'docx')).toThrow(ValidationError);
  });

  it('不正な filename (パスセパレータ) は ValidationError', () => {
    expect(() => bookArtifact(BOOK_ID, 'cover_source', 'a/b.png')).toThrow(ValidationError);
  });
});

describe('chapterDraft', () => {
  it('chapter index をゼロ詰めで埋め込む', () => {
    expect(chapterDraft(BOOK_ID, 3)).toBe(
      `books/${BOOK_ID}/manuscript/source/chapter-03.md`,
    );
    expect(chapterDraft(BOOK_ID, 12)).toBe(
      `books/${BOOK_ID}/manuscript/source/chapter-12.md`,
    );
  });

  it('同じ入力で必ず同じキーになる (決定的)', () => {
    expect(chapterDraft(BOOK_ID, 5)).toBe(chapterDraft(BOOK_ID, 5));
  });

  it('負の chapterIdx は ValidationError', () => {
    expect(() => chapterDraft(BOOK_ID, -1)).toThrow(ValidationError);
  });

  it('非整数 chapterIdx は ValidationError', () => {
    expect(() => chapterDraft(BOOK_ID, 1.5)).toThrow(ValidationError);
  });
});

describe('kdpScreenshot', () => {
  it('bookId / jobId / step からキーを生成する', () => {
    expect(kdpScreenshot(BOOK_ID, JOB_ID, 'login')).toBe(
      `books/${BOOK_ID}/kdp/screenshots/${JOB_ID}-login.png`,
    );
    expect(kdpScreenshot(BOOK_ID, JOB_ID, 'metadata_upload')).toBe(
      `books/${BOOK_ID}/kdp/screenshots/${JOB_ID}-metadata_upload.png`,
    );
  });

  it('step は小文字英字始まりが必須', () => {
    expect(() => kdpScreenshot(BOOK_ID, JOB_ID, 'Login')).toThrow(ValidationError);
    expect(() => kdpScreenshot(BOOK_ID, JOB_ID, '1step')).toThrow(ValidationError);
    expect(() => kdpScreenshot(BOOK_ID, JOB_ID, 'login/path')).toThrow(ValidationError);
  });

  it('不正な jobId は ValidationError', () => {
    expect(() => kdpScreenshot(BOOK_ID, 'bad job', 'login')).toThrow(ValidationError);
  });

  it('不正な bookId は ValidationError', () => {
    expect(() => kdpScreenshot('bad book', JOB_ID, 'login')).toThrow(ValidationError);
  });
});

describe('補助キー (jobsArchive / catalogSnapshot / accountAvatar)', () => {
  it('jobsArchive', () => {
    expect(jobsArchive('2026-05')).toBe('archive/jobs/2026-05.jsonl.gz');
    expect(() => jobsArchive('2026-5')).toThrow(ValidationError);
    expect(() => jobsArchive('2026-05-01')).toThrow(ValidationError);
  });

  it('catalogSnapshot', () => {
    expect(catalogSnapshot('2026-05-17')).toBe('catalog/snapshots/2026-05-17.json');
  });

  it('accountAvatar', () => {
    expect(accountAvatar(ACCOUNT_ID)).toBe(`accounts/${ACCOUNT_ID}/meta/avatar.png`);
  });

  it('channelAvatar / channelBanner (F-057)', () => {
    expect(channelAvatar('x')).toBe('promotion/x/meta/avatar.png');
    expect(channelBanner('tiktok')).toBe('promotion/tiktok/meta/banner.jpg');
  });

  it('channelAvatar は不正 channel で ValidationError', () => {
    expect(() => channelAvatar('X')).toThrow(ValidationError); // 大文字不可
    expect(() => channelAvatar('')).toThrow(ValidationError);
    expect(() => channelBanner('a/b')).toThrow(ValidationError);
  });

  it('bookPromoImage (F-058)', () => {
    expect(bookPromoImage(BOOK_ID)).toBe(`books/${BOOK_ID}/promo/social.jpg`);
    expect(() => bookPromoImage('bad id')).toThrow(ValidationError);
  });

  it('promotionPostImage (F-059)', () => {
    expect(promotionPostImage('post_123')).toBe('promotion/posts/post_123.jpg');
    expect(() => promotionPostImage('bad id')).toThrow(ValidationError);
  });

  it('dbBackup は archive/db/<ymd>.sql.gz を返す', () => {
    expect(dbBackup('2026-05-23')).toBe('archive/db/2026-05-23.sql.gz');
    expect(dbBackup('2026-12-31')).toBe('archive/db/2026-12-31.sql.gz');
  });

  it('dbBackup は不正な YMD で ValidationError', () => {
    expect(() => dbBackup('2026-5-23')).toThrow(ValidationError);
    expect(() => dbBackup('2026-05')).toThrow(ValidationError);
    expect(() => dbBackup('2026-05-23T00:00:00Z')).toThrow(ValidationError);
    expect(() => dbBackup('')).toThrow(ValidationError);
  });
});

describe('softDeletedKey', () => {
  it('プレフィックス `_deleted/` を付与する', () => {
    expect(softDeletedKey('books/abc/manuscript/final.docx')).toBe(
      '_deleted/books/abc/manuscript/final.docx',
    );
  });

  it('既に _deleted/ 配下ならそのまま返す (冪等)', () => {
    const k = '_deleted/books/abc/manuscript/final.docx';
    expect(softDeletedKey(k)).toBe(k);
  });
});

describe('決定性 / 副作用なし', () => {
  it('全関数は同じ入力で同じ出力を返す', () => {
    expect(bookArtifact(BOOK_ID, 'docx')).toBe(bookArtifact(BOOK_ID, 'docx'));
    expect(accountAvatar(ACCOUNT_ID)).toBe(accountAvatar(ACCOUNT_ID));
  });
});
