import { CLAUDE_SIGNAL_SOURCE } from './hooks.js';
import { CLAUDE_TURN_SOURCE } from './control.js';
import { CLAUDE_STATUSLINE_SOURCE } from './statusline.js';

export const claudeRuntimeAssets = () => ({
  'puddle-signal.mjs': CLAUDE_SIGNAL_SOURCE,
  'puddle-turn.mjs': CLAUDE_TURN_SOURCE,
  'puddle-statusline.mjs': CLAUDE_STATUSLINE_SOURCE,
});
