import { huddleComponentSchema, huddleDefinitionSchema, huddleResultReadout } from '@puddle/shared';
import { huddleRevisionDigest } from '../../../src/huddle/definitions/revision.js';

export function customTriggerSnapshot(
  huddleId: string,
  source: string,
  worktree: string,
  resume: 'continue' | 'fresh' = 'continue',
) {
  const component = huddleComponentSchema.parse({
    format: 1,
    id: 'fixture.trigger.external',
    version: 1,
    category: 'trigger',
    title: 'External source',
    entry: './run.ts',
    trigger: { resume },
    capabilities: ['files'],
    parameters: { worktree: { schema: { type: 'string' }, editor: 'worktree' } },
    outputs: { event: { schema: { type: 'number' }, emission: 'event' } },
  });
  const definition = huddleDefinitionSchema.parse({
    format: 1,
    id: huddleId,
    name: 'Custom trigger fixture',
    nodes: [
      {
        id: 'source',
        source: { kind: 'local', manifest: 'nodes/example/node.json' },
        parameters: { worktree: { kind: 'literal', value: worktree } },
      },
      { id: 'result', source: { kind: 'builtin', component: huddleResultReadout.id, version: 1 } },
    ],
    edges: [
      {
        id: 'result',
        from: { node: 'source', port: 'event' },
        to: { node: 'result', port: 'value' },
      },
    ],
  });
  const components = { source: component, result: huddleResultReadout };
  const files = {
    'huddle.json': JSON.stringify(definition),
    'nodes/example/node.json': JSON.stringify(component),
    'nodes/example/run.ts': source,
  };
  return {
    format: 1 as const,
    digest: huddleRevisionDigest(files, components),
    definition,
    components,
    files,
    diagnostics: [],
  };
}

/** Watches only explicit fixture files; serial processing and close await the pending callback. */
export const fileTriggerSource = `import {HuddleTrigger} from 'puddlang/huddle'; import fs from 'node:fs';
export default HuddleTrigger({contract:'./node.json', async open(context,cursor) {
  const root=context.bindings.worktree;
  fs.appendFileSync(root+'/opened',JSON.stringify(cursor)+'\\n');
  let current=cursor, closed=false, pending=Promise.resolve();
  const scan=async()=> {
    if(closed || !fs.existsSync(root+'/input.json')) return;
    const event=JSON.parse(fs.readFileSync(root+'/input.json','utf8'));
    if(current===event.id) return;
    const receipt=await context.emit({id:event.id,port:'event',data:event.value,nextCursor:event.id});
    current=event.id;
    fs.writeFileSync(root+'/ack',JSON.stringify(receipt));
  };
  const watcher=fs.watch(root,(_event,name)=> {
    if(name==='input.json') pending=pending.then(scan).catch(async error=> {
      if(!closed && !context.signal.aborted) await context.health({state:'degraded',message:error.message});
    });
  });
  await scan();
  return {async close() {closed=true;watcher.close();await pending;fs.appendFileSync(root+'/closed','x');}};
}});`;
