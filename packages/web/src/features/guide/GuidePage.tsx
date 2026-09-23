import { useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import { ErrorBoundary } from '../../components/error-boundary';
import { renderGuideMarkdown } from './guide-markdown';
import content from './guide.md?raw';

// Owned, editable documentation; raw HTML is disabled. The origin is inserted
// before rendering so code blocks retain Markdown's ordinary escaping.
const html = renderGuideMarkdown(content.replaceAll('{{APP_ORIGIN}}', location.origin));

export function GuidePage() {
  useEffect(() => {
    document.title = 'Guide · Puddle';
  }, []);
  return (
    <ErrorBoundary scope="Guide">
      <main className="mx-auto max-w-3xl px-6 py-10 sm:px-10 sm:py-16">
        <a
          href="/"
          className="mb-10 inline-flex items-center gap-2 text-sm text-fg-muted transition-colors hover:text-fg"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back to Puddle
        </a>
        <article
          aria-label="Puddle Guide"
          className="md-preview text-base text-fg-secondary [&_h2]:mt-12 [&_h2]:scroll-mt-6 [&_pre]:bg-transparent [&_pre]:px-0 [&_pre]:text-sm [&_pre]:text-fg"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </main>
    </ErrorBoundary>
  );
}
