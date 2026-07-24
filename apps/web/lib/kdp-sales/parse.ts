/**
 * 互換シム: KDP レポートパーサは共有パッケージ @a2p/kdp-report に移動した
 * (web の手動アップロード取込 と worker の自動取得 で共有するため)。
 * 既存 import パス (@/lib/kdp-sales/parse) を壊さないよう再エクスポートする。
 */
export * from '@a2p/kdp-report';
