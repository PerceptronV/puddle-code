import { describe, expect, it, vi } from 'vitest';
import {
  fileResponseSchema,
  projectDetailSchema,
  treeResponseSchema,
  uiStateResponseSchema,
} from '@puddle/shared';
import { files, profile, project } from '../../src/dev/preview/data';
import { previewRequest } from '../../src/dev/preview/requests';

describe('standalone UI preview', () => {
  it('provides a valid project, working set, nested tree and editable in-memory files', async () => {
    expect(
      projectDetailSchema.parse(
        await (await previewRequest('GET', `/api/projects/${project.id}`)).json(),
      ).project.id,
    ).toBe(project.id);
    uiStateResponseSchema.parse(
      await (await previewRequest('GET', `/api/profiles/${profile.id}/state`)).json(),
    );
    const tree = treeResponseSchema.parse(
      await (
        await previewRequest('GET', '/api/worktrees/preview/tree?path=packages/web/src')
      ).json(),
    );
    expect(tree.entries.map((entry) => entry.name)).toContain('App.tsx');
    const path = '/api/worktrees/preview/file?path=README.md';
    const before = fileResponseSchema.parse(await (await previewRequest('GET', path)).json());
    try {
      const saved = await (
        await previewRequest('PUT', path, { content: '# Edited sample' })
      ).json();
      const after = fileResponseSchema.parse(await (await previewRequest('GET', path)).json());
      expect(after.content).toBe('# Edited sample');
      expect(after.mtime_ms).toBe(saved.mtime_ms);
      expect(after.mtime_ms).toBeGreaterThan(before.mtime_ms);
    } finally {
      files.set('README.md', before.content!);
    }
  });

  it('rejects host operations and unknown paths without network fallback', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      for (const [method, path] of [
        ['POST', '/api/sessions'],
        ['POST', '/frontend/updates'],
        ['PUT', '/api/worktrees/preview/file?path=/etc/passwd'],
        ['GET', '/api/not-a-fixture'],
      ]) {
        const response = await previewRequest(method!, path!, { content: 'blocked' });
        expect(response.status).toBe(501);
        expect((await response.json()).error.code).toBe('preview_unavailable');
      }
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });
});
