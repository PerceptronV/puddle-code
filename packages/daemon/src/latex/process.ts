/** LaTeX shares bounded process execution with the other compilation providers. */
export {
  CompilationCommandError as LatexCommandError,
  disposeCompilationCommands as disposeLatexCommands,
  runCompilationCommand as runLatexCommand,
  type CompilationCommand as LatexCommand,
  type CompilationCommandResult as LatexCommandResult,
  type CompilationCommandRunner as LatexCommandRunner,
} from '../compilation/process.js';
