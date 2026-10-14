import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { puddlangRunnerInputSchema } from '@puddle/shared';
import * as api from './runtime-api.js';

// Load dependencies before installing the single-file program's import policy.
const apiUrl = new URL('./runtime-api.js', import.meta.url).href;
const zodUrl = import.meta.resolve('zod');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith('data:text/javascript')) {
      if (specifier === 'puddlang') return nextResolve(apiUrl, context);
      if (specifier === 'zod') return nextResolve(zodUrl, context);
      if (!specifier.startsWith('node:'))
        throw new Error(
          'Initial puddlang programs are single-file; import puddlang, zod or node: built-ins only',
        );
    }
    return nextResolve(specifier, context);
  },
});
let started = false;
process.on('disconnect', () => process.exit(1));
process.on('message', (raw) => {
  const parsed = puddlangRunnerInputSchema.safeParse(raw);
  if (!parsed.success || parsed.data.type !== 'start' || started) return;
  started = true;
  const message = parsed.data;
  void (async () => {
    api.setInput(message.input);
    const source = stripTypeScriptTypes(message.source, { mode: 'strip' });
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    )) as { default?: unknown };
    finish({ result: module.default ?? null });
  })().catch((error: unknown) =>
    finish({ error: (error instanceof Error ? error.message : String(error)).slice(0, 8192) }),
  );
});
function finish(value: { result?: unknown; error?: string }): void {
  const message = { type: 'finished', ...value };
  try {
    if (Buffer.byteLength(JSON.stringify(message)) > 256 * 1024)
      throw new Error('Program result exceeds 256 KiB');
    process.send?.(message, () => process.exit(value.error ? 1 : 0));
  } catch (error) {
    process.send?.({ type: 'finished', error: String(error).slice(0, 8192) }, () =>
      process.exit(1),
    );
  }
}
