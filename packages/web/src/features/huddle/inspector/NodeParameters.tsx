import { useId, useState } from 'react';
import {
  huddleBindingSchema,
  completionHuddleTrigger,
  type HuddleBinding,
  type HuddleComponent,
  type HuddleDefinition,
  type HuddleNodeDefinition,
  type HuddleParameter,
  type Session,
} from '@puddle/shared';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { graphActionClass, type EditGraph } from './GraphEditing';
import { useNodeResourceOptions, type NodeResourceOptions } from './resources';

export function NodeParameters({
  node,
  component,
  variables,
  nodes,
  edit,
  session,
}: {
  node: HuddleNodeDefinition;
  component?: HuddleComponent;
  variables: HuddleDefinition['variables'];
  nodes: HuddleDefinition['nodes'];
  edit: EditGraph;
  session: Session;
}) {
  const resources = useNodeResourceOptions(
    session,
    node,
    Object.values(component?.parameters ?? {}).some((parameter) =>
      ['worktree', 'session', 'account', 'agent', 'project'].includes(parameter.editor),
    ),
    component,
  );
  const set = (name: string, binding: HuddleBinding | undefined) =>
    edit((graph) => ({
      ...graph,
      nodes: graph.nodes.map((item) => {
        if (item.id !== node.id) return item;
        const parameters = { ...item.parameters };
        if (binding) parameters[name] = binding;
        else delete parameters[name];
        return { ...item, parameters };
      }),
    }));
  return (
    <div className="flex flex-col gap-4 py-3">
      {Object.entries(component?.parameters ?? {}).map(([name, parameter]) => (
        <Parameter
          key={`${name}:${JSON.stringify(node.parameters[name])}`}
          name={name}
          parameter={parameter}
          binding={node.parameters[name]}
          variables={variables}
          resources={resources}
          completionChoices={
            component?.nativeCompletion === name
              ? nodes
                  .filter(
                    (item) =>
                      item.source.kind === 'builtin' &&
                      item.source.component === completionHuddleTrigger.id,
                  )
                  .map((item) => ({ value: item.id, label: item.id }))
              : undefined
          }
          set={(binding) => set(name, binding)}
        />
      ))}
      {resources.error && (
        <p className="text-xs text-fg-muted">Resource choices: {resources.error}</p>
      )}
      {!component && (
        <pre className="whitespace-pre-wrap break-words text-xs">
          {JSON.stringify(node.parameters, null, 2)}
        </pre>
      )}
      {component && Object.keys(component.parameters).length === 0 && (
        <p className="text-xs text-fg-muted">No settings for this node.</p>
      )}
    </div>
  );
}

function Parameter({
  name,
  parameter,
  binding,
  variables,
  set,
  resources,
  completionChoices,
}: {
  name: string;
  parameter: HuddleParameter;
  binding?: HuddleBinding;
  variables: HuddleDefinition['variables'];
  set(binding: HuddleBinding | undefined): void;
  resources: NodeResourceOptions;
  completionChoices?: Array<{ value: string; label: string }>;
}) {
  const id = useId();
  const [kind, setKind] = useState(binding?.kind ?? 'literal');
  const value =
    binding?.kind === 'literal' ? binding.value : binding ? undefined : parameter.default;
  const textValue = parameter.schema.type === 'string';
  const [text, setText] = useState(
    binding?.kind === 'variable'
      ? binding.name
      : value === undefined
        ? ''
        : textValue
          ? String(value)
          : JSON.stringify(value),
  );
  let candidate: HuddleBinding | undefined;
  try {
    candidate = huddleBindingSchema.parse(
      kind === 'variable'
        ? { kind, name: text }
        : { kind, value: textValue ? text : JSON.parse(text) },
    );
  } catch {
    /* Keep partially entered JSON local until Apply. */
  }
  const choices =
    completionChoices ??
    (parameter.editor === 'worktree'
      ? resources.worktrees
      : parameter.editor === 'session'
        ? resources.sessions
        : parameter.editor === 'account'
          ? resources.accounts
          : parameter.editor === 'project'
            ? resources.projects
            : parameter.editor === 'agent'
              ? resources.providers
              : undefined);
  return (
    <div className="flex flex-col gap-2" role="group" aria-label={parameter.title ?? name}>
      <Label htmlFor={id}>
        {parameter.title ?? name}
        {parameter.required ? ' *' : ''}
      </Label>
      <select
        aria-label={`${name} binding`}
        value={kind}
        className="rounded-md bg-surface p-1 text-xs"
        onChange={(event) => {
          setKind(event.target.value as 'literal' | 'variable');
          setText('');
        }}
      >
        <option value="literal">Value</option>
        <option value="variable">Variable</option>
      </select>
      {kind === 'variable' ? (
        <select
          id={id}
          value={text}
          className="rounded-md bg-surface p-1 text-sm"
          onChange={(event) => setText(event.target.value)}
        >
          <option value="">Choose variable</option>
          {Object.keys(variables).map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
      ) : choices ? (
        <select
          id={id}
          value={text}
          className="rounded-md bg-surface p-1 text-sm"
          onChange={(event) => setText(event.target.value)}
        >
          <option value="">
            Choose{' '}
            {completionChoices
              ? 'completion trigger'
              : parameter.editor === 'agent'
                ? 'provider'
                : parameter.editor}
          </option>
          {text && !choices.some((choice) => choice.value === text) && (
            <option value={text}>{text} · unavailable</option>
          )}
          {choices.map((choice) => (
            <option value={choice.value} key={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      ) : parameter.schema.enum ? (
        <select
          id={id}
          value={text}
          className="rounded-md bg-surface p-1 text-sm"
          onChange={(event) => setText(event.target.value)}
        >
          <option value="">Choose value</option>
          {text &&
            !parameter.schema.enum.some(
              (value) => (textValue ? String(value) : JSON.stringify(value)) === text,
            ) && <option value={text}>{text} · not in options</option>}
          {parameter.schema.enum.map((value) => {
            const encoded = textValue ? String(value) : JSON.stringify(value);
            return (
              <option key={encoded} value={encoded}>
                {typeof value === 'string' ? value : JSON.stringify(value)}
              </option>
            );
          })}
        </select>
      ) : parameter.editor === 'prompt' ? (
        <textarea
          id={id}
          value={text}
          rows={5}
          className="min-h-24 w-full resize-y rounded-md bg-surface p-2 text-sm text-fg outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onChange={(event) => setText(event.target.value)}
        />
      ) : parameter.schema.type === 'boolean' ? (
        <select
          id={id}
          value={text}
          className="rounded-md bg-surface p-1 text-sm"
          onChange={(event) => setText(event.target.value)}
        >
          <option value="">Choose value</option>
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
      ) : (
        <Input
          id={id}
          type={['number', 'integer'].includes(String(parameter.schema.type)) ? 'number' : 'text'}
          min={parameter.schema.minimum}
          max={parameter.schema.maximum}
          step={parameter.schema.type === 'integer' ? 1 : 'any'}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={textValue ? parameter.description : 'JSON value'}
        />
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className={graphActionClass}
          disabled={!candidate}
          onClick={() => candidate && set(candidate)}
        >
          Apply setting
        </button>
        <button
          type="button"
          className={graphActionClass}
          disabled={!binding}
          onClick={() => set(undefined)}
        >
          Clear setting
        </button>
      </div>
      {parameter.description && <p className="text-xs text-fg-muted">{parameter.description}</p>}
      {!binding && parameter.default !== undefined && (
        <p className="text-xs text-fg-muted">Default: {JSON.stringify(parameter.default)}</p>
      )}
      {parameter.editor === 'worktree' && (
        <p className="text-xs text-fg-muted">
          Use an explicit worktree root or a worktree variable.
        </p>
      )}
    </div>
  );
}
