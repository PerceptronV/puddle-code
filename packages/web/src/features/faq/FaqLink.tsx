import { cn } from '../../lib/utils';

export function FaqLink({ className }: { className?: string }) {
  return (
    <p className={cn('text-sm text-fg-muted', className)}>
      For setup or upgrade instructions, see{' '}
      <a
        href="/faq"
        className="text-accent transition-colors hover:text-accent-hover hover:underline"
      >
        FAQs
      </a>
      .
    </p>
  );
}
