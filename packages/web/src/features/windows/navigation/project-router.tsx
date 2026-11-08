import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPath, UNSAFE_NavigationContext, useLocation } from 'react-router';
import { desktopWindowRouteSchema } from '@puddle/shared';
import { desktopBridge } from '../../../lib/desktop';
import { toastError } from '../../../lib/transport/errors';
import { useCurrentProfileId } from '../../profile/profile-store';
import { desktopWindowContext } from '../window-context';
import { navigateProjectRoute } from './project-actions';

/** One routing boundary covers links, palette actions, notifications and history visits. */
export function ProjectWindowRouter({ children }: { children: ReactNode }) {
  const navigation = useContext(UNSAFE_NavigationContext);
  const location = useLocation();
  const profileId = useCurrentProfileId();
  const bridge = desktopBridge()?.windows?.projects;
  const context = desktopWindowContext();
  const approved = useRef<string | null>(null);
  const [, render] = useState(0);
  const intent = useRef(0);
  const key = `${profileId}:${location.pathname}`;
  const identity = context?.identity;
  const anchored =
    identity &&
    identity.kind !== 'host' &&
    (location.pathname === `/project/${identity.projectId}` ||
      location.pathname.startsWith(`/project/${identity.projectId}/session/`));
  if (context?.stagingTransfer || context?.stagingArrangement || anchored) approved.current = key;

  const value = useMemo(() => {
    if (!bridge || !profileId) return navigation;
    const intercept =
      (method: 'push' | 'replace'): typeof navigation.navigator.push =>
      (...args) => {
        const [to] = args;
        const path =
          (typeof to === 'string' ? to : createPath(to)).split(/[?#]/)[0] || location.pathname;
        if (!desktopWindowRouteSchema.safeParse(path).success) {
          navigation.navigator[method](...args);
          return;
        }
        const request = ++intent.current;
        void bridge
          .route({ profileId, route: path })
          .then((handled) => {
            if (request !== intent.current || handled) return;
            approved.current = `${profileId}:${path}`;
            navigation.navigator[method](...args);
          })
          .catch(toastError);
      };
    return {
      ...navigation,
      navigator: {
        ...navigation.navigator,
        push: intercept('push'),
        replace: intercept('replace'),
      },
    };
  }, [bridge, profileId, navigation, location.pathname]);

  useEffect(() => {
    if (!bridge || !profileId || approved.current === key) return;
    let active = true;
    const fallback = () => {
      const identity = context?.identity;
      const route = identity && identity.kind !== 'host' ? `/project/${identity.projectId}` : '/';
      approved.current = `${profileId}:${route}`;
      navigateProjectRoute(route);
      render((value) => value + 1);
    };
    void bridge
      .route({ profileId, route: location.pathname })
      .then((handled) => {
        if (!active) return;
        if (handled) fallback();
        else {
          approved.current = key;
          render((value) => value + 1);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          toastError(error);
          fallback();
        }
      });
    return () => {
      active = false;
    };
  }, [bridge, profileId, key, location.pathname, context]);

  // Gate only unmediated initial/POP navigation. Normal route changes retain the
  // same Workspace instance; staged handoffs intentionally remount its models.
  if (bridge && profileId && approved.current !== key) return null;
  return (
    <UNSAFE_NavigationContext.Provider value={value}>{children}</UNSAFE_NavigationContext.Provider>
  );
}
