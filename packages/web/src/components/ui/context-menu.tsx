import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import { ChevronRight } from 'lucide-react';
import * as React from 'react';
import { cn } from '../../lib/utils';
import { menuHighlightRadix, menuRow } from './recipes';

/** Owned shadcn-style wrapper over Radix context-menu, styled like `dropdown-menu.tsx`. */
export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuSub = ContextMenuPrimitive.Sub;

export function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        className={cn(
          'z-50 min-w-36 overflow-hidden rounded-md bg-elevated p-1 shadow-xl',
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item>) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(menuRow, menuHighlightRadix, '[&_svg]:size-3.5', className)}
      {...props}
    />
  );
}

export function ContextMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger>) {
  return (
    <ContextMenuPrimitive.SubTrigger
      className={cn(
        menuRow,
        menuHighlightRadix,
        'data-[state=open]:bg-action data-[state=open]:text-action-ink [&_svg]:size-3.5',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto" />
    </ContextMenuPrimitive.SubTrigger>
  );
}

export function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        className={cn(
          'z-50 min-w-36 overflow-hidden rounded-md bg-elevated p-1 shadow-xl',
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

/**
 * Props for an element whose DOUBLE-click opens its own context menu (SPEC §12) —
 * the counterpart to `editOnDoubleClick`, for labels where the menu (not an
 * inline edit) is the right second gesture: the sidebar's project name and
 * abbreviation, whose menus carry Rename among several other actions, so
 * double-clicking straight into a rename was picking one of them at random.
 *
 * As with `editOnDoubleClick`, the FIRST click still does whatever the element
 * does (the project links navigate); the second is suppressed via
 * `defaultPrevented`, which react-router's `Link` honours, so it does not fire
 * twice. The menu is opened by dispatching a real `contextmenu` event at the
 * cursor — Radix's trigger listens for exactly that, and this way the menu
 * anchors where a right-click would have put it.
 */
export function menuOnDoubleClick(): {
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
} {
  return {
    onClick: (e) => {
      if (e.detail === 2) e.preventDefault();
    },
    onDoubleClick: (e) => {
      e.preventDefault();
      e.currentTarget.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: e.clientX,
          clientY: e.clientY,
          button: 2,
        }),
      );
    },
  };
}
