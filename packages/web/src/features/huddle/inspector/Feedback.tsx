import { useId, useState } from 'react';
import type { HuddleEdge, HuddleValueSchema } from '@puddle/shared';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import type { EditGraph } from './GraphEditing';

export function booleanOutputPaths(
  schema: HuddleValueSchema | undefined,
  prefix: string[] = [],
): string[][] {
  if (!schema || prefix.length > 16) return [];
  if (schema.type === 'boolean' && prefix.length) return [prefix];
  return Object.entries(schema.properties ?? {}).flatMap(([name, child]) =>
    booleanOutputPaths(child, [...prefix, name]),
  );
}
export function Feedback({
  edge,
  schema,
  edit,
}: {
  edge: HuddleEdge;
  schema?: HuddleValueSchema;
  edit: EditGraph;
}) {
  const id = useId();
  const paths = booleanOutputPaths(schema);
  const [rounds, setRounds] = useState<string | null>(null);
  const set = (feedback: HuddleEdge['feedback']) =>
    edit((graph) => ({
      ...graph,
      edges: graph.edges.map((item) => {
        if (item.id !== edge.id) return item;
        const { feedback: _previous, ...rest } = item;
        return feedback ? { ...rest, feedback } : rest;
      }),
    }));
  return (
    <div className="flex flex-col gap-2 text-xs">
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={!!edge.feedback}
          disabled={!edge.feedback && !paths.length}
          onChange={(event) =>
            set(
              event.target.checked
                ? { maxRounds: 5, while: { path: paths[0]!, equals: false } }
                : undefined,
            )
          }
        />
        Bounded feedback
      </label>
      {edge.feedback && (
        <>
          <Label htmlFor={`${id}-condition`}>Continue while</Label>
          <select
            id={`${id}-condition`}
            className="rounded-md bg-surface p-1 text-sm"
            value={JSON.stringify(edge.feedback.while.path)}
            onChange={(event) =>
              set({
                ...edge.feedback!,
                while: { ...edge.feedback!.while, path: JSON.parse(event.target.value) },
              })
            }
          >
            {!paths.some(
              (path) => JSON.stringify(path) === JSON.stringify(edge.feedback!.while.path),
            ) && (
              <option value={JSON.stringify(edge.feedback.while.path)}>
                {edge.feedback.while.path.join('.')} · unavailable
              </option>
            )}
            {paths.map((path) => (
              <option key={JSON.stringify(path)} value={JSON.stringify(path)}>
                {path.join('.')}
              </option>
            ))}
          </select>
          <select
            aria-label="Feedback condition value"
            value={String(edge.feedback.while.equals)}
            className="rounded-md bg-surface p-1 text-sm"
            onChange={(event) =>
              set({
                ...edge.feedback!,
                while: { ...edge.feedback!.while, equals: event.target.value === 'true' },
              })
            }
          >
            <option value="false">False</option>
            <option value="true">True</option>
          </select>
          <Label htmlFor={`${id}-rounds`}>Maximum rounds</Label>
          <Input
            id={`${id}-rounds`}
            type="number"
            min={1}
            max={1000}
            value={rounds ?? String(edge.feedback.maxRounds)}
            onChange={(event) => setRounds(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            onBlur={() => {
              const value = Number(rounds);
              if (rounds !== null && Number.isInteger(value) && value >= 1 && value <= 1000)
                set({ ...edge.feedback!, maxRounds: value });
              setRounds(null);
            }}
          />
        </>
      )}
    </div>
  );
}
