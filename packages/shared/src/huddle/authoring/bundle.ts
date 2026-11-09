import { huddleFlowTemplates, huddleFlowTemplateFiles } from '../templates/flow/catalogue.js';
import { huddleStarters, huddleStarterFiles } from '../templates/graphs/catalogue.js';
import { fileReportFiles } from '../templates/readouts/file.js';
import { PROTOCOL_VERSION } from '../../protocol.js';
import { huddleDefinitionSchema } from '../../api/huddle/definitions.js';
import { huddleAuthoringSchemas } from './schemas.js';
import { huddleSdkTypes } from './sdk.js';
import { huddleAuthoringGuide } from './guide.js';
import {
  authoringComponents,
  boundedHttpSource,
  feedSource,
  reportSource,
} from './templates/components.js';

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const local = (id: string) => ({
  id,
  source: { kind: 'local', manifest: `nodes/${id}/node.json` },
});
const edge = (id: string, from: string, port: string, to: string) => ({
  id,
  from: { node: from, port },
  to: { node: to, port: 'value' },
});

/** Data only: no project reads, import/evaluation of templates, or host capability claims. */
export function huddleAuthoringFiles(): Record<string, string> {
  const files: Record<string, string> = {
    'README.md': huddleAuthoringGuide,
    ...Object.fromEntries(
      Object.entries(fileReportFiles).map(([name, contents]) => [
        `templates/file-report/${name}`,
        contents,
      ]),
    ),
    'types/puddlang-huddle.d.ts': huddleSdkTypes,
    ...Object.fromEntries(
      Object.entries(huddleAuthoringSchemas()).map(([path, schema]) => [path, json(schema)]),
    ),
    'templates/feed/trigger.ts': feedSource,
    'templates/feed/http.ts': boundedHttpSource,
    'templates/report/readout.ts': reportSource,
    'templates/report/http.ts': boundedHttpSource,
    'fixtures/feed-page.json': json({
      gap: false,
      cursor: 'page-1',
      events: [{ id: 'event-1', cursor: 'event-1', data: { message: 'fixture' } }],
    }),
    'fixtures/feed-gap.json': json({ gap: true, cursor: 'expired', events: [] }),
    'fixtures/report-confirmation.json': json({ accepted: true, receipt: { id: 'receipt-1' } }),
    'fixtures/transform.json': json({
      inputs: { value: { message: 'fixture' } },
      outputs: { completed: { message: 'fixture' } },
    }),
  };
  for (const item of huddleFlowTemplates)
    for (const [name, contents] of Object.entries(huddleFlowTemplateFiles(item.template)!.files))
      files[`templates/${item.template}/${name}`] = contents;
  for (const starter of huddleStarters)
    for (const [path, content] of Object.entries(
      huddleStarterFiles(
        starter.id,
        '0'.repeat(32),
        starter.title,
        '/replace/with/registered/worktree',
      ).files,
    ))
      files[`starters/${starter.id}/${path}`] = content;
  for (const [name, component] of Object.entries(authoringComponents))
    files[`templates/${name}/node.json`] = json(component);
  files['examples/manual.json'] = json(
    huddleDefinitionSchema.parse({
      format: 1,
      id: '0'.repeat(32),
      name: 'Manual transform example',
      nodes: [
        { id: 'run', source: { kind: 'builtin', component: 'puddle.trigger.manual', version: 1 } },
        local('transform'),
        {
          id: 'result',
          source: { kind: 'builtin', component: 'puddle.readout.result', version: 1 },
        },
      ],
      edges: [
        edge('input', 'run', 'event', 'transform'),
        edge('output', 'transform', 'completed', 'result'),
      ],
    }),
  );
  files['examples/feed-report.json'] = json(
    huddleDefinitionSchema.parse({
      format: 1,
      id: '0'.repeat(32),
      name: 'Feed to report example',
      variables: {
        feedUrl: { schema: { type: 'string' }, editor: 'text' },
        reportUrl: { schema: { type: 'string' }, editor: 'text' },
      },
      nodes: [
        {
          ...local('feed'),
          parameters: {
            url: { kind: 'variable', name: 'feedUrl' },
            intervalMs: { kind: 'literal', value: 60000 },
          },
        },
        local('transform'),
        { ...local('report'), parameters: { endpoint: { kind: 'variable', name: 'reportUrl' } } },
      ],
      edges: [
        edge('input', 'feed', 'event', 'transform'),
        edge('output', 'transform', 'completed', 'report'),
      ],
    }),
  );
  files['examples/flow.json'] = json(
    huddleDefinitionSchema.parse({
      format: 1,
      id: '0'.repeat(32),
      name: 'Conditional flow and joined branches',
      nodes: [
        { id: 'run', source: { kind: 'builtin', component: 'puddle.trigger.manual', version: 1 } },
        local('condition'),
        local('merge'),
        local('transform'),
        {
          ...local('format-text'),
          parameters: { template: { kind: 'literal', value: 'Message: {{input.message}}' } },
        },
        local('join'),
        {
          id: 'result',
          source: { kind: 'builtin', component: 'puddle.readout.result', version: 1 },
        },
      ],
      edges: [
        edge('input', 'run', 'event', 'condition'),
        {
          id: 'matched',
          from: { node: 'condition', port: 'matched' },
          to: { node: 'merge', port: 'left' },
        },
        {
          id: 'unmatched',
          from: { node: 'condition', port: 'unmatched' },
          to: { node: 'merge', port: 'right' },
        },
        edge('transform', 'merge', 'completed', 'transform'),
        edge('format', 'merge', 'completed', 'format-text'),
        {
          id: 'left',
          from: { node: 'transform', port: 'completed' },
          to: { node: 'join', port: 'left' },
        },
        {
          id: 'right',
          from: { node: 'format-text', port: 'completed' },
          to: { node: 'join', port: 'right' },
        },
        edge('result', 'join', 'completed', 'result'),
      ],
    }),
  );
  return files;
}

export function readHuddleAuthoring(path?: string) {
  const files = huddleAuthoringFiles();
  const metadata = {
    format: 1 as const,
    application: PROTOCOL_VERSION,
    source: 'bundled-client' as const,
  };
  if (path !== undefined) {
    if (!Object.hasOwn(files, path)) throw new Error('Unknown authoring asset; list the kit first');
    return { ...metadata, path, content: files[path]! };
  }
  return {
    ...metadata,
    files: Object.entries(files).map(([path, content]) => ({
      path,
      bytes: new TextEncoder().encode(content).length,
    })),
  };
}
