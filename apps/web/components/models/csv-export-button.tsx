'use client';

/**
 * CsvExportButton (S-020) — `/api/model-catalog/export.csv` を新規タブで開く。
 *
 * Route handler が `Content-Disposition: attachment` を付けるためダウンロードが
 * 開始する。Anchor タグでも代替可能だが、disabled state や aria 制御の
 * 一貫性のためボタン + window.location.href のパターンを採用。
 */
import { Button } from '@/components/ui/button';
import { messages } from '@/lib/messages';

export function CsvExportButton() {
  const m = messages.modelCatalog;

  function onClick() {
    window.location.href = '/api/model-catalog/export.csv';
  }

  return (
    <Button
      type="button"
      variant="outline"
      data-testid="catalog-csv-export"
      onClick={onClick}
    >
      {m.actions.csvExport}
    </Button>
  );
}
