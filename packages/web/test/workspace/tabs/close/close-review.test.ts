import { expect, it } from 'vitest';
import { CloseReview } from '../../../../src/features/workspace/tabs/close/close-review';

it('coalesces repeated close gestures but never approves another tab', async () => {
  const review = new CloseReview<string>();
  const first = review.request('a', 'first draft');
  expect(review.request('a', 'first draft')).toBe(first);
  expect(await review.request('b', 'other draft')).toBe(false);
  review.finish(review.get(), true);
  expect(await first).toBe(true);
});

it('cancels an unanswered dialogue on quit and rejects its late discard callback', async () => {
  const review = new CloseReview<string>();
  const quit = new AbortController();
  const first = review.request('a', 'draft', quit.signal);
  const stale = review.get();
  quit.abort();
  expect(await first).toBe(false);
  const second = review.request('a', 'new review');
  review.finish(stale, true);
  expect(review.get()?.promise).toBe(second);
  review.cancel();
  expect(await second).toBe(false);
});

it('does not open a review after cancellation or allow a late abort to cancel its replacement', async () => {
  const review = new CloseReview<null>();
  const old = new AbortController();
  const accepted = review.request('a', null, old.signal);
  review.finish(review.get(), true);
  expect(await accepted).toBe(true);
  const next = review.request('b', null);
  old.abort();
  expect(review.get()?.promise).toBe(next);
  expect(await review.request('a', null, old.signal)).toBe(false);
  review.cancel();
  expect(await next).toBe(false);
});
