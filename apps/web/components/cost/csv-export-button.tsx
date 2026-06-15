'use client';

/**
 * S-024 CsvExportButton (T-07-05).
 *
 * Triggers download of /api/cost/export.csv.
 */
import { useCallback, useState } from 'react';

import { messages } from '@/lib/messages';

interface CsvExportButtonProps {
  year: number;
  month: number;
}

const m = messages.costDashboard.csvExport;

export function CsvExportButton({ year, month }: CsvExportButtonProps) {
  const [isExporting, setIsExporting] = useState(false);

  const handleClick = useCallback(async () => {
    setIsExporting(true);
    try {
      const url = `/api/cost/export.csv?year=${year}&month=${month}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `${m.filename}-${year}-${String(month).padStart(2, '0')}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      setIsExporting(false);
    }
  }, [year, month]);

  return (
    <button
      className="inline-flex items-center rounded-button border border-border-warm bg-cream-light px-4 py-2 text-button font-medium text-charcoal hover:bg-charcoal-04 disabled:opacity-50"
      disabled={isExporting}
      onClick={handleClick}
      data-testid="csv-export-button"
    >
      {isExporting ? m.exporting : m.button}
    </button>
  );
}
