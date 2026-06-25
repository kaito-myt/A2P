/**
 * カタカナ/ひらがな → ヘボン式ローマ字 変換 (F-020b)。
 *
 * KDP 入稿のローマ字欄向け。LLM ではなく決定的な変換で行う。
 * 完全な形態素解析は行わず、カナ表記をそのまま音写する
 * (フリガナ=カナ読みが入力前提なので実用上十分)。
 */

const DIGRAPHS: Record<string, string> = {
  キャ: 'kya', キュ: 'kyu', キョ: 'kyo',
  シャ: 'sha', シュ: 'shu', ショ: 'sho',
  チャ: 'cha', チュ: 'chu', チョ: 'cho',
  ニャ: 'nya', ニュ: 'nyu', ニョ: 'nyo',
  ヒャ: 'hya', ヒュ: 'hyu', ヒョ: 'hyo',
  ミャ: 'mya', ミュ: 'myu', ミョ: 'myo',
  リャ: 'rya', リュ: 'ryu', リョ: 'ryo',
  ギャ: 'gya', ギュ: 'gyu', ギョ: 'gyo',
  ジャ: 'ja', ジュ: 'ju', ジョ: 'jo',
  ヂャ: 'ja', ヂュ: 'ju', ヂョ: 'jo',
  ビャ: 'bya', ビュ: 'byu', ビョ: 'byo',
  ピャ: 'pya', ピュ: 'pyu', ピョ: 'pyo',
  // 外来音
  シェ: 'she', チェ: 'che', ジェ: 'je',
  ティ: 'ti', ディ: 'di', トゥ: 'tu', ドゥ: 'du',
  ファ: 'fa', フィ: 'fi', フェ: 'fe', フォ: 'fo',
  ウィ: 'wi', ウェ: 'we', ウォ: 'wo', ヴァ: 'va', ヴィ: 'vi', ヴェ: 've', ヴォ: 'vo',
};

const MONOGRAPHS: Record<string, string> = {
  ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o',
  カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko',
  サ: 'sa', シ: 'shi', ス: 'su', セ: 'se', ソ: 'so',
  タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to',
  ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no',
  ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho',
  マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo',
  ヤ: 'ya', ユ: 'yu', ヨ: 'yo',
  ラ: 'ra', リ: 'ri', ル: 'ru', レ: 're', ロ: 'ro',
  ワ: 'wa', ヰ: 'wi', ヱ: 'we', ヲ: 'o', ン: 'n',
  ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge', ゴ: 'go',
  ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo',
  ダ: 'da', ヂ: 'ji', ヅ: 'zu', デ: 'de', ド: 'do',
  バ: 'ba', ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo',
  パ: 'pa', ピ: 'pi', プ: 'pu', ペ: 'pe', ポ: 'po',
  ヴ: 'vu',
  // 小書き単独 (フォールバック)
  ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o', ャ: 'ya', ュ: 'yu', ョ: 'yo',
};

const VOWEL_OF: Record<string, string> = { a: 'a', i: 'i', u: 'u', e: 'e', o: 'o' };

function hiraganaToKatakana(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    // ひらがな (3041-3096) → カタカナ (+0x60)
    if (code >= 0x3041 && code <= 0x3096) out += String.fromCodePoint(code + 0x60);
    else out += ch;
  }
  return out;
}

/**
 * カナ文字列をヘボン式ローマ字に変換する。漢字や英数字はそのまま通す。
 * 入力は通常フリガナ (カタカナ) を想定。ひらがなはカタカナに正規化する。
 */
export function kanaToRomaji(input: string): string {
  if (!input) return '';
  const s = hiraganaToKatakana(input);
  let out = '';
  let sokuon = false; // 促音 (ッ) フラグ

  for (let i = 0; i < s.length; i++) {
    const two = s.slice(i, i + 2);
    const one = s[i]!;

    if (one === 'ッ') {
      sokuon = true;
      continue;
    }
    if (one === 'ー') {
      // 長音: 直前の母音を伸ばす (ヘボン式の簡易処理として母音を重ねる)
      const last = out.slice(-1);
      if (VOWEL_OF[last]) out += last;
      continue;
    }

    let roma: string | undefined;
    let consumed = 1;
    if (DIGRAPHS[two]) {
      roma = DIGRAPHS[two];
      consumed = 2;
    } else if (MONOGRAPHS[one]) {
      roma = MONOGRAPHS[one];
    }

    if (roma === undefined) {
      // 変換できない文字 (漢字・記号・英数字) はそのまま
      out += one;
      sokuon = false;
      continue;
    }

    if (sokuon) {
      // 促音: 次の子音を重ねる (ch は tch)
      const first = roma[0]!;
      out += roma.startsWith('ch') ? 't' : first;
      sokuon = false;
    }
    out += roma;
    i += consumed - 1;
  }

  return out;
}
