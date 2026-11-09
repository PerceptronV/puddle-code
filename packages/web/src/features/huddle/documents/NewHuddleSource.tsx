import { huddleStarters, type HuddleStarter, type HuddleDiscovery } from '@puddle/shared';
import { Label } from '../../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select';

export type HuddleStartingPoint =
  | { kind: 'blank' }
  | { kind: 'template'; template: HuddleStarter }
  | { kind: 'copy'; id: string; digest: string; name: string; worktree: string };

export function NewHuddleSource({
  source,
  setSource,
  definitions,
  worktree,
  pending,
  canCopy,
  canStart,
  valid,
}: {
  source: HuddleStartingPoint;
  setSource(value: HuddleStartingPoint): void;
  definitions: HuddleDiscovery;
  worktree: string;
  pending: boolean;
  canCopy: boolean;
  canStart: boolean;
  valid: boolean;
}) {
  const saved = definitions.filter((item) => 'digest' in item);
  const template =
    source.kind === 'template'
      ? huddleStarters.find((item) => item.id === source.template)
      : undefined;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="huddle-source">Start from</Label>
      <Select
        value={
          source.kind === 'copy'
            ? source.id
            : source.kind === 'template'
              ? source.template
              : 'blank'
        }
        disabled={pending}
        onValueChange={(value) => {
          if (value === 'blank') setSource({ kind: 'blank' });
          else {
            const starter = canStart ? huddleStarters.find((item) => item.id === value) : undefined;
            const selected = canCopy ? saved.find((item) => item.id === value) : undefined;
            if (starter) setSource({ kind: 'template', template: starter.id });
            else if (selected)
              setSource({
                kind: 'copy',
                id: selected.id,
                digest: selected.digest,
                name: selected.name,
                worktree,
              });
          }
        }}
      >
        <SelectTrigger id="huddle-source">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="blank">Blank graph</SelectItem>
          {canStart &&
            huddleStarters.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.title}
              </SelectItem>
            ))}
          {canCopy &&
            saved.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                Copy: {item.name} · {item.id.slice(0, 8)}
              </SelectItem>
            ))}
          {source.kind === 'copy' && !saved.some((item) => item.id === source.id) && (
            <SelectItem value={source.id} disabled>
              Unavailable: {source.name}
            </SelectItem>
          )}
        </SelectContent>
      </Select>
      {template && <p className="text-xs text-fg-muted">{template.description}</p>}
      {source.kind === 'copy' && (
        <p className="text-xs text-fg-muted">
          Copies saved files only, with a new id. Review copied worktree, account and session
          settings before Start.
        </p>
      )}
      {!valid && (
        <p role="status" className="text-xs text-fg-muted">
          The selected source changed or is unavailable. Select Blank graph, then choose the source
          again after reviewing its saved files.
        </p>
      )}
    </div>
  );
}
