import { GEMINI_SIGNAL_SOURCE } from './hooks.js';
import { GEMINI_TURN_SOURCE } from './control.js';

export const geminiRuntimeAssets = () => ({
  'puddle-signal.mjs': GEMINI_SIGNAL_SOURCE,
  'puddle-turn.mjs': GEMINI_TURN_SOURCE,
});
