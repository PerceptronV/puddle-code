import { createHash } from 'node:crypto';
import { huddleValidationSchema, type HuddleDiagnostic } from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from '../definitions/capture.js';
import { checkedHuddlePath, readHuddleFile } from '../definitions/files.js';
import { validateHuddleModules } from './modules.js';
import { validateHuddleFixture } from './fixtures.js';

export async function checkHuddleSource(
  snapshot: HuddleDefinitionSnapshot,
  worktree: string,
  paths: string[],
  check: () => void,
) {
  const diagnostics: HuddleDiagnostic[] = [];
  let valid = true;
  const add = (items: HuddleDiagnostic[]) => {
    valid &&= !items.some((item) => item.severity === 'error');
    diagnostics.push(...items);
    diagnostics.sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'));
    diagnostics.splice(512);
  };
  add([...snapshot.diagnostics, ...validateHuddleModules(snapshot)]);
  const fixtures: { path: string; digest: string; cases: number }[] = [];
  const root = await checkedHuddlePath(worktree, `.puddle/huddle/${snapshot.definition.id}`);
  for (const path of [...new Set(paths)]) {
    check();
    try {
      const text = await readHuddleFile(root, path);
      const result = validateHuddleFixture(snapshot, text, path);
      if ((await readHuddleFile(root, path)) !== text)
        throw new Error('Fixture changed during validation');
      fixtures.push({
        path,
        digest: createHash('sha256').update(text).digest('hex'),
        cases: result.cases,
      });
      add(result.diagnostics);
    } catch (error) {
      add([
        {
          severity: 'error',
          code: 'fixture_invalid',
          path: `/fixtures/${path}`,
          message: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
        },
      ]);
    }
  }
  check();
  return huddleValidationSchema.parse({
    valid,
    digest: snapshot.digest,
    diagnostics,
    checks: { modules: true, fixtures },
  });
}
