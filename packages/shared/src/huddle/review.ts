import {
  huddleReviewSchema,
  huddleRetainedRevisionSchema,
  type HuddleRetainedRevisionRequest,
  type HuddleRevisionReview,
  type HuddleDiffReview,
} from '../api/huddle/review.js';

/** A read response must not substitute a newer target, digest or selected entry. */
export function parseHuddleReview(input: HuddleRevisionReview | HuddleDiffReview, value: unknown) {
  const review = huddleReviewSchema.parse(value);
  if (
    Object.entries(input.target).some(
      ([key, value]) => review.target[key as keyof typeof review.target] !== value,
    )
  )
    throw new Error('Huddle review returned another owner or activation');
  if (
    'expected_digest' in input
      ? review.saved?.digest !== input.expected_digest
      : review.saved !== null
  )
    throw new Error('Huddle review returned another saved revision');
  if (
    input.entry &&
    (!review.content ||
      input.entry.kind !== review.content.entry.kind ||
      input.entry.path !== review.content.entry.path)
  )
    throw new Error('Huddle review returned another source entry');
  return review;
}

/** Recorded source is bound to the requested owner and immutable revision, never a live target. */
export function parseHuddleRetainedRevision(input: HuddleRetainedRevisionRequest, value: unknown) {
  const review = huddleRetainedRevisionSchema.parse(value);
  if (
    review.owner.runtimeId !== input.owner.runtimeId ||
    review.owner.incarnation !== input.owner.incarnation
  )
    throw new Error('Retained revision returned another owner');
  if (
    input.revision
      ? review.revision !== input.revision || review.activation !== null
      : !review.activation
  )
    throw new Error('Retained revision returned another revision or activation');
  if (
    input.expected_digest ? review.saved?.digest !== input.expected_digest : review.saved !== null
  )
    throw new Error('Retained revision returned another saved revision');
  if (
    input.entry &&
    (!review.content ||
      review.content.entry.kind !== input.entry.kind ||
      review.content.entry.path !== input.entry.path)
  )
    throw new Error('Retained revision returned another source entry');
  return review;
}
