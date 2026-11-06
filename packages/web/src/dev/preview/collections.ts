import { savedLayoutSchema, scratchpadEntrySchema } from '@puddle/shared';
import { profile } from './data';

// In-memory examples only: a reload resets edits, and no daemon is contacted.
const notes = ['Review checklist', 'Next steps'].map((title, index) =>
  scratchpadEntrySchema.parse({
    id: index + 1,
    profile_id: profile.id,
    scope: 'profile',
    project_id: null,
    title,
    body: index
      ? 'Try a different layout and compare the panes.'
      : 'Check the diff, run the focused tests, and review the result.',
    tags: [],
    agent_type: null,
    position: index,
    created_at: profile.created_at,
    updated_at: profile.created_at,
  }),
);
const layouts: ReturnType<typeof savedLayoutSchema.parse>[] = [];
let nextId = 10;

export function previewCollection(method: string, route: string, body: object): Response | null {
  const match = /^\/api\/(scratchpad|layouts)(?:\/(\d+))?$/.exec(route);
  if (!match) return null;
  const collection = match[1] === 'scratchpad' ? notes : layouts;
  const schema = match[1] === 'scratchpad' ? scratchpadEntrySchema : savedLayoutSchema;
  if (method === 'GET') return Response.json(collection);
  const index = collection.findIndex((item) => item.id === Number(match[2]));
  if (method === 'DELETE' && index >= 0) {
    collection.splice(index, 1);
    return new Response(null, { status: 204 });
  }
  if (method !== 'POST' && !(method === 'PATCH' && index >= 0)) return null;
  const parsed = schema.safeParse({
    id: nextId++,
    profile_id: profile.id,
    project_id: null,
    title: null,
    tags: [],
    agent_type: null,
    position: -nextId,
    active_session: null,
    layout_tree: null,
    created_at: profile.created_at,
    updated_at: profile.created_at,
    ...(index >= 0 ? collection[index] : {}),
    ...body,
  });
  if (!parsed.success)
    return Response.json(
      { error: { code: 'invalid', message: 'Invalid preview entry' } },
      { status: 400 },
    );
  if (match[1] === 'scratchpad') {
    const item = scratchpadEntrySchema.parse(parsed.data);
    if (index >= 0) notes[index] = item;
    else notes.push(item);
  } else {
    const item = savedLayoutSchema.parse(parsed.data);
    if (index >= 0) layouts[index] = item;
    else layouts.push(item);
  }
  return Response.json(parsed.data);
}
