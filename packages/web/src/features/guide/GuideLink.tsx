import { cn } from '../../lib/utils';

export function GuideLink({ className }: { className?: string }) {
  return (
    <p className={cn('text-sm text-fg-muted', className)}>
      For setup or upgrade instructions, see{' '}
      <a
        href="/guide"
        className="text-accent transition-colors hover:text-accent-hover hover:underline"
      >
        Guide
      </a>
      .
    </p>
  );
}
