/**
 * F-055 — 章タイトル正規化。
 *
 * 生成された `heading` には「第1章: はじめに——…」のように **章番号や前書き/後書きラベルが
 * 埋め込まれている**ことがあり、表示側でさらに「第N章」を前置すると
 * 「第 2 章: 第1章 …」のような二重番号になる。さらに はじめに/おわりに が
 * 番号付き章として扱われる不具合もある。
 *
 * ここで決定的に正規化する:
 *  1. heading から先頭の「第N章」「はじめに/おわりに 等」＋区切りを剥がして純粋な題名にする
 *  2. はじめに系=intro / おわりに系=outro / それ以外=body に分類
 *  3. body だけに 1..M の連番を振り直す (intro/outro は番号を持たない)
 *  4. 表示用タイトル行 `titleLine` を組み立てる (body: 「第K章　題名」, intro/outro: 題名のみ)
 */

export type ChapterKind = 'intro' | 'body' | 'outro';

export interface NormalizedChapter {
  /** 元の index (表示順の識別用)。 */
  index: number;
  kind: ChapterKind;
  /** body の連番 (1..M)。intro/outro は null。 */
  bodyNumber: number | null;
  /** 番号・前置きラベルを取り除いた純粋な題名。 */
  cleanHeading: string;
  /** 表示・出力にそのまま使えるタイトル行。 */
  titleLine: string;
}

const INTRO_RE = /^(はじめに|序章|序文|序|プロローグ|まえがき|前書き)/;
const OUTRO_RE = /^(おわりに|終章|結び|結章|エピローグ|あとがき|後書き)/;
// 「第12章」「第 3 章」「Chapter 4」等の先頭章番号 + 直後の区切り。
const LEADING_CHAPTER_NUM_RE =
  /^\s*(?:第\s*[0-9０-９]+\s*章|chapter\s*[0-9]+)\s*[:：.．、，,\-—―ー　\s]*/i;

/** heading から先頭の「第N章」ラベル + 区切りを 1 段だけ剥がす。 */
function stripLeadingChapterNumber(heading: string): string {
  const stripped = heading.replace(LEADING_CHAPTER_NUM_RE, '');
  return stripped.trim().length > 0 ? stripped.trim() : heading.trim();
}

function classify(clean: string): ChapterKind {
  if (INTRO_RE.test(clean)) return 'intro';
  if (OUTRO_RE.test(clean)) return 'outro';
  return 'body';
}

/**
 * 章配列を正規化する。入力の並び順を保持し、各章に kind / bodyNumber / cleanHeading /
 * titleLine を付ける。
 */
export function normalizeChapters(
  chapters: Array<{ index?: number | null; heading: string }>,
): NormalizedChapter[] {
  let bodyCounter = 0;
  return chapters.map((ch, i) => {
    const index = typeof ch.index === 'number' && Number.isFinite(ch.index) ? ch.index : i + 1;
    const clean = stripLeadingChapterNumber(ch.heading ?? '');
    const kind = classify(clean);
    let bodyNumber: number | null = null;
    let titleLine: string;
    if (kind === 'body') {
      bodyCounter += 1;
      bodyNumber = bodyCounter;
      titleLine = `第${bodyNumber}章　${clean}`;
    } else {
      titleLine = clean;
    }
    return { index, kind, bodyNumber, cleanHeading: clean, titleLine };
  });
}

/**
 * 単一章のタイトル行を得る簡便版 (配列全体が無い箇所向け)。
 * 前書き/後書き判定はできるが body 連番は index ベースになる点に注意。
 */
export function formatChapterTitle(index: number, heading: string): string {
  const clean = stripLeadingChapterNumber(heading ?? '');
  const kind = classify(clean);
  return kind === 'body' ? `第${index}章　${clean}` : clean;
}
