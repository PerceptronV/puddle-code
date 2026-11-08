import { lazy, Suspense } from 'react';
import type { Session } from '@puddle/shared';

const Pane = lazy(() => import('./HuddlePane').then((module) => ({ default: module.HuddlePane })));
export function LazyHuddlePane({ session }: { session: Session }) {
  return (
    <Suspense fallback={<p className="p-4 text-sm text-fg-muted">Loading huddle…</p>}>
      <Pane session={session} />
    </Suspense>
  );
}
