import { ApiError } from '../../../errors.js';

// Do not queue arbitrary transfers behind slow clients or disks. Shared by all
// route instances, so another profile/window cannot multiply the I/O budget.
let active = 0;
export function admitFileTransfer(): () => void {
  if (active >= 4)
    throw new ApiError(503, 'transfer_busy', 'Too many active file transfers; try again shortly');
  active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
  };
}
