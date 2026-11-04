import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
} from 'node:fs';
import type { HostRemovalServiceReview } from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import { openServiceDefinitionDirectory } from '../../supervision/definition-directory.js';

/** Verify bounded bytes and inode immediately before deletion; retain durable intent on any failure. */
export function removeReviewedServiceDefinition(
  review: HostRemovalServiceReview,
  requireCurrent: () => void,
): void {
  const parent = openServiceDefinitionDirectory(review.definition);
  try {
    const file = openSync(
      review.definition,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = fstatSync(file);
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o022) !== 0 ||
        info.nlink !== 1 ||
        info.size > 64 * 1024
      )
        throw new Error('Unsafe service definition before deletion');
      const bytes = Buffer.alloc(info.size + 1);
      const count = readSync(file, bytes, 0, bytes.length, 0);
      if (
        count !== info.size ||
        digest(bytes.subarray(0, count).toString('base64')) !== review.sourceDigest
      )
        throw new Error('Host service source changed before deletion');
      const current = lstatSync(review.definition);
      if (current.dev !== info.dev || current.ino !== info.ino || current.nlink !== 1)
        throw new Error('Host service definition changed before deletion');
      requireCurrent();
      unlinkSync(review.definition);
      fsyncSync(parent);
    } finally {
      closeSync(file);
    }
  } finally {
    closeSync(parent);
  }
}
