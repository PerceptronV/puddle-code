import { PuddleGlyph } from '../../../components/puddle-glyph';
import { NODE_ICONS } from '../appearance/node-icons';
import { compactAction } from '../../../components/ui/recipes';

export function NodeIconChoices({
  value,
  onSelect,
}: {
  value?: string | null;
  onSelect(icon: string | null): void;
}) {
  return (
    <div className="grid grid-cols-8 gap-1" aria-label="Node icons">
      <button
        type="button"
        aria-label="Default node icon"
        className={compactAction}
        onClick={() => onSelect(null)}
      >
        <PuddleGlyph className="size-4" />
      </button>
      {NODE_ICONS.map(({ name, Icon }) => (
        <button
          type="button"
          key={name}
          title={name}
          aria-label={name}
          aria-pressed={value === name}
          className={compactAction}
          onClick={() => onSelect(name)}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  );
}
