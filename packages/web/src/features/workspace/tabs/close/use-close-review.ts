import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { CloseReview } from './close-review';

export function useCloseReview<T>(scope: string) {
  const { review } = useMemo(() => ({ scope, review: new CloseReview<T>() }), [scope]);
  useEffect(() => () => review.cancel(), [review]);
  const pending = useSyncExternalStore(review.subscribe, review.get);
  return { review, pending };
}
