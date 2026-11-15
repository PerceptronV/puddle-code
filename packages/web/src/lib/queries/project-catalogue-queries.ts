import { useQuery } from '@tanstack/react-query';
import { projectCatalogueSchema } from '@puddle/shared';
import { api } from '../transport/api';
import { projectCacheScope } from './project-scope';
import { projectListCache } from './project-cache';
import { catalogueView } from './project-catalogue';

export function useProjectCatalogue(profile: string | undefined, enabled: boolean) {
  const scope = projectCacheScope();
  return useQuery({
    queryKey: ['project-catalogue', scope, profile ?? 'all'],
    enabled,
    queryFn: async ({ signal }) => {
      const value = projectCatalogueSchema.parse(
        await api(
          'GET',
          `/api/projects/catalogue${profile === undefined ? '' : `?profile=${encodeURIComponent(profile)}`}`,
          undefined,
          signal,
        ),
      );
      const view = catalogueView(value);
      if (!signal.aborted && projectCacheScope() === scope)
        projectListCache.write(scope, view.projects, profile);
      return view;
    },
  });
}
