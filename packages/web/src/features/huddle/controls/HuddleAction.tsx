import type { ButtonHTMLAttributes, ComponentType } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { compactAction } from '../../../components/ui/recipes';
import { cn } from '../../../lib/utils';

/** The same compact, labelled actions used by workspace sidebar trays. */
export function HuddleAction({
  icon: Icon,
  label,
  title,
  className,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(compactAction, className)}
          {...props}
        >
          <Icon className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{title ?? label}</TooltipContent>
    </Tooltip>
  );
}
