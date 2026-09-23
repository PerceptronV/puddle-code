import { useEffect } from 'react';
import MarkdownIt from 'markdown-it';
import { ArrowLeft } from 'lucide-react';
import { ErrorBoundary } from '../../components/error-boundary';
import content from './faq.md?raw';

// Owned, editable documentation; raw HTML is disabled. The origin is inserted
// before rendering so code blocks retain Markdown's ordinary escaping.
const markdown = new MarkdownIt({ html: false });
const html = markdown.render(content.replaceAll('{{APP_ORIGIN}}', location.origin));

export function FaqPage() {
  useEffect(() => {
    document.title = 'FAQs · Puddle';
  }, []);
  return (
    <ErrorBoundary scope="FAQs">
      <main className="mx-auto max-w-3xl px-6 py-10 sm:px-10 sm:py-16">
        <a
          href="/"
          className="mb-10 inline-flex items-center gap-2 text-sm text-fg-muted transition-colors hover:text-fg"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back to Puddle
        </a>
        <article
          aria-label="Frequently asked questions"
          className="md-preview text-base text-fg-secondary [&_h2]:mt-12 [&_pre]:bg-transparent [&_pre]:px-0 [&_pre]:text-sm [&_pre]:text-fg"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </main>
    </ErrorBoundary>
  );
}
