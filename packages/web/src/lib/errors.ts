import { toast } from 'sonner';

/**
 * The single place a failed action becomes visible.
 *
 * Every mutation is covered by a global handler (App.tsx), so an action can
 * never fail silently just because its call site forgot a handler. Call sites
 * that need extra behaviour — resetting a field, closing a dialog — still
 * write their own `onError` and call this for the message.
 *
 * The toast id is derived from the message so the global net and a local
 * handler reporting the same failure collapse into ONE toast rather than
 * stacking two identical ones.
 */
export function toastError(error: unknown): void {
  toast.error(message(error), { id: `err:${message(error)}` });
}

function message(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error;
  return 'Something went wrong';
}
