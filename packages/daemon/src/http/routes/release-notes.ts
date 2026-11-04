import { Hono } from 'hono';
import { installedReleaseNotes } from '../../host/releases/notes.js';

export function releaseNotesRoutes(home: string | undefined, version: string): Hono {
  return new Hono().get('/', (c) => c.json(installedReleaseNotes(home, version)));
}
