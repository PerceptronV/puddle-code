# Code files and notebooks

Run against a daemon started from a plain shell, locally and over SSH. Tool
discovery and execution must occur on that host, using protocol 24.3 or newer.

1. Open a Python file with a visible print statement. With Python installed,
   the tab offers **Run file** and **Compilation Settings…**, with only the
   **When clicked** command. No lightning control appears. Edit without saving,
   then run: the edit is saved first and the output opens beside the source.
   Change a file on disk: it must never execute automatically.
2. Repeat with C and C++ using the host's `cc`/`c++`, Clang or GCC. Use command
   settings to select a second installed compiler and add standard/include/link
   flags while retaining `{{binary}}`. Verify the programme runs after a
   successful build. Introduce a syntax error: show compiler output, keep the
   last successful result, and never execute an old binary. Use a filename and
   directory containing spaces and shell punctuation.
3. Check another installed interpreter (JavaScript, TypeScript, Go, Ruby, Perl,
   R, Bash/Zsh) and Rust where available. Missing tools must not expose runnable
   tabs. Installing a tool becomes visible after capability-cache expiry and
   window refocus. Override an interpreter with an explicit virtual-environment
   path and arguments; verify those exact arguments reach the programme.
4. Open a version 4 `.ipynb` containing Markdown/maths, code, saved stdout,
   an error traceback, an image and a rich HTML table. The notebook view renders
   them; script output and interactive widgets never execute. The source toggle
   exposes JSON and returns to the notebook without losing edits.
5. Edit, add, reorder and delete cells; save and reopen. Preserve kernelspec,
   cell ids, tags, attachments and unknown extension fields. Editing a code cell
   clears only its old output and execution count. Verify draft restoration and
   stale-file reconciliation after another editor changes the file. A malformed
   notebook shows a repair message and remains accessible in source view.
6. With `jupyter-nbconvert` and the notebook's kernel installed, run the notebook.
   Check all cells execute in a fresh kernel, an executed copy opens, and the
   source file's saved outputs remain unchanged. Re-run after changing a value:
   update the existing result tab. A missing kernel/import or failing cell
   reports Jupyter's error and retains the previous successful result.
7. Inspect `.puddle/code/<provider>/<source-hash>/`: outputs and binaries stay
   under this source root, five recent runs remain, and the stable current
   result refreshes only after success. Exercise an endless loop, excessive
   stdout and daemon shutdown; bounded commands and their process groups stop.
   Input-reading programmes receive EOF; interactive programmes use terminals.
8. Verify LaTeX still has both manual and eager controls, custom commands,
   generated PDF refresh and inverse SyncTeX. In the remote mobile Files view,
   verify notebook preview is inert and read-only; remote execution is absent.

Automated coverage: `code-provider.test.ts`, `notebook-format.test.ts`, and
`e2e/notebook.test.ts`; the existing compilation and LaTeX suites cover shared
orchestration and command settings. Notebook execution follows Jupyter's
[nbconvert execution interface](https://nbconvert.readthedocs.io/en/latest/execute_api.html)
and preserves the [version 4 notebook format](https://nbformat.readthedocs.io/en/latest/format_description.html).
