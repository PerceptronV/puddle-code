import { ShieldCheck } from 'lucide-react';
import { HuddleAction } from '../controls/HuddleAction';
import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  huddleValidateSchema,
  huddleValidationSchema,
  supportsApplicationFeature,
  type Session,
} from '@puddle/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../../components/ui/dialog';
import { Label } from '../../../components/ui/label';
import { fieldSurface } from '../../../components/ui/recipes';
import { useDaemonVersion } from '../../../lib/queries/queries';
import { api } from '../../../lib/transport/api';
import { graphActionClass } from '../inspector/GraphEditing';

export function ValidationAction({ profile, session }: { profile: string; session: Session }) {
  const [open, setOpen] = useState(false);
  const supported = supportsApplicationFeature(useDaemonVersion().data?.protocol, {
    major: 28,
    minor: 31,
  });
  return (
    <>
      <HuddleAction
        icon={ShieldCheck}
        label="Validate"

        disabled={!supported}
        title={
          supported
            ? 'Check saved modules and optional contract fixtures'
            : 'Module validation requires a newer host'
        }
        onClick={() => setOpen(true)}
      />
      {open && (
        <ValidationDialog profile={profile} session={session} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function ValidationDialog({
  profile,
  session,
  onClose,
}: {
  profile: string;
  session: Session;
  onClose(): void;
}) {
  const id = useId();
  const [paths, setPaths] = useState('');
  const validation = useMutation({
    retry: false,
    mutationFn: async () => {
      const parsed = huddleValidateSchema.safeParse({
        project_id: session.project_id,
        worktree: session.worktree_path,
        huddle_id: session.huddle_id,
        fixtures: paths
          .split('\n')
          .map((path) => path.trim())
          .filter(Boolean),
      });
      if (!parsed.success)
        throw new Error('Use at most 16 relative fixture paths inside this huddle directory.');
      const { huddle_id, ...body } = parsed.data;
      return huddleValidationSchema.parse(
        await api('POST', `/api/huddle/${profile}/definitions/${huddle_id}/validate`, body),
      );
    },
  });
  const result = validation.data;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent wide>
        <DialogTitle>Validate saved huddle</DialogTitle>
        <DialogDescription>
          Check graph wiring, module declarations and optional sample values. Uses saved files; save
          your edits first to include them. This check does not run scripts or contact agents.
        </DialogDescription>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            validation.mutate();
          }}
        >
          <Label htmlFor={id}>Contract fixture paths (optional)</Label>
          <textarea
            id={id}
            className={`${fieldSurface} min-h-20 resize-y p-2 text-sm`}
            value={paths}
            disabled={validation.isPending}
            onChange={(event) => {
              setPaths(event.target.value);
              validation.reset();
            }}
          />
          <p className="text-xs text-fg-muted">
            One JSON file per line, relative to this huddle's directory.
          </p>
          <button
            className={`${graphActionClass} self-start`}
            type="submit"
            disabled={validation.isPending}
          >
            {validation.isPending ? 'Checking…' : 'Check saved source'}
          </button>
        </form>
        {validation.error && (
          <p role="alert" className="text-sm text-fg-muted">
            {validation.error.message}
          </p>
        )}
        {result && (
          <div className="flex flex-col gap-2 text-sm" role="status">
            <p>{result.valid ? 'Saved source checks passed.' : 'Saved source needs attention.'}</p>
            <p className="text-xs text-fg-muted">
              Checked revision {result.digest.slice(0, 12)}. Recheck after source changes.
            </p>
            {result.checks?.fixtures.map((fixture) => (
              <p key={fixture.path} className="text-xs">
                {fixture.path}: {fixture.cases} sample cases
              </p>
            ))}
            <ul className="max-h-64 overflow-auto text-xs">
              {result.diagnostics.map((item, index) => (
                <li key={index} className="py-1">
                  {item.node && `${item.node}: `}
                  {item.message} <span className="text-fg-muted">{item.path}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-fg-muted">
              Samples are checked against contracts, not executed. Runtime value checks and live
              resource admission still apply.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
