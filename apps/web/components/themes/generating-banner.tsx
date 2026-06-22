'use client';

/**
 * テーマ生成中バナー。Marketer の Web 検索付き生成は 1〜2 分かかるため、
 * 候補が出るまで「生成中」を表示し、一定間隔で router.refresh() して
 * 候補が揃ったら自動でテーブル表示へ切り替える。
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export function GeneratingBanner() {
  const router = useRouter();
  const [secs, setSecs] = useState(0);

  useEffect(() => {
    const tick = setInterval(() => setSecs((s) => s + 1), 1000);
    const poll = setInterval(() => router.refresh(), 7000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [router]);

  return (
    <div
      data-testid="themes-generating"
      className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
    >
      <div className="flex items-center justify-center gap-3">
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-charcoal border-t-transparent" />
        <p className="text-body font-medium text-charcoal">
          マーケターがテーマを生成中です…
        </p>
      </div>
      <p className="mt-2 text-button-sm text-muted">
        Web 検索を伴うため 1〜2 分かかります。完了すると自動で表示されます（経過 {secs} 秒）。
      </p>
    </div>
  );
}
