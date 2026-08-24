import { useClientSettings } from '../../lib/client-settings';
import { DraftingCursor } from './DraftingCursor';
import { InvertCursor } from './InvertCursor';
import { RangefinderCursor } from './RangefinderCursor';

/** Mounts the renderer owned by the selected cursor package. */
export function CursorHost() {
  const { cursorPackage } = useClientSettings();
  switch (cursorPackage) {
    case 'rangefinder':
      return <RangefinderCursor />;
    case 'drafting':
      return <DraftingCursor />;
    case 'invert':
      return <InvertCursor />;
    case 'system':
      return null;
  }
}
