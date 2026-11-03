import { claudeCode } from './claude-code/index.js';
import { codex } from './codex/index.js';
import { opencode } from './opencode/index.js';
import { geminiCli } from './gemini-cli/index.js';

/** Shared by catalogue/application services and independent runtime owners. */
export const defaultAdapters = [claudeCode, codex, opencode, geminiCli];
