'use client';

/**
 * ArtifactDownloadGroup (T-05-11 / docs/04 S-009).
 *
 * Renders docx/pdf/png download links for a book's artifacts.
 * Each link points to `/api/artifacts/[id]/download` which 302s to a signed R2 URL.
 */
import { messages } from '@/lib/messages';
import { findArtifactByKind, type BookArtifactSerialized } from '@/lib/books-view';

const m = messages.books.download;

interface ArtifactDownloadGroupProps {
  artifacts: readonly BookArtifactSerialized[];
}

const ARTIFACT_KINDS = [
  { kind: 'docx', label: m.docx },
  { kind: 'pdf', label: m.pdf },
  { kind: 'png_cover', label: m.png },
] as const;

export function ArtifactDownloadGroup({ artifacts }: ArtifactDownloadGroupProps) {
  const hasAny = artifacts.length > 0;
  if (!hasAny) {
    return <span className="text-button-sm text-muted">{m.noArtifacts}</span>;
  }

  return (
    <span className="inline-flex items-center gap-2" data-testid="artifact-download-group">
      {ARTIFACT_KINDS.map(({ kind, label }) => {
        const artifactId = findArtifactByKind(artifacts, kind);
        if (!artifactId) {
          return (
            <span
              key={kind}
              className="text-button-sm text-muted"
              data-testid={`artifact-link-${kind}-disabled`}
            >
              {label}
            </span>
          );
        }
        return (
          <a
            key={kind}
            href={`/api/artifacts/${artifactId}/download`}
            className="text-button-sm text-charcoal underline-offset-4 hover:underline"
            data-testid={`artifact-link-${kind}`}
          >
            {label}
          </a>
        );
      })}
    </span>
  );
}
