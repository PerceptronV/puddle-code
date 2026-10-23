# Code files and notebooks

Run against a daemon started from a plain shell, locally and over SSH. Tool
discovery and execution must occur on that host, using protocol 24.6 or newer.

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
6. With `jupyter-nbconvert` and the notebook's kernel installed, use header
   **Run All** and the tab play button. An executed copy opens and the source's
   saved outputs stay unchanged. Run `counter = globals().get("counter", 0) + 1`
   followed by `print(counter)` twice: results are 1 and 2, with continuing
   execution counts. Close/reopen the source tab and reconnect the browser:
   another run returns 3. A different notebook starts with its own state.
   Missing kernels/imports and failing cells retain the last successful result.
7. Select an installed kernel from the header; verify the kernelspec edit is
   saved through ordinary notebook saving. **Restart kernel** starts fresh;
   **Shut down kernel** stops it, and the next explicit run starts a new one.
   Interrupt an endless loop; the current run fails and earlier variables remain
   available. A kernel that exits reports dead and requires Restart; it must not
   replay the interrupted source. Verify daemon shutdown and abrupt daemon exit
   leave no child kernels. Repeat shutdown while a kernel is starting.
8. Use header Code/Markdown and the raw-cell menu: each new cell is revealed and
   focused. Clear All Outputs removes execution counts/results without changing
   source, cell ids or other metadata; undo and saving still work. Outline
   entries reveal the matching cells. Confirm header controls wrap in narrow
   panes without obscuring notebook content. Generate is intentionally absent.

9. Inspect `.puddle/code/<provider>/<source-hash>/`: outputs and binaries stay
   under this source root, five recent runs remain, and the stable current
   result refreshes only after success. Exercise an endless loop, excessive
   stdout and daemon shutdown; ordinary bounded commands and their process groups stop; notebook output limits interrupt the active execution while retaining the kernel.
   Input-reading programmes receive EOF; interactive programmes use terminals.
10. Verify LaTeX still has both manual and eager controls, custom commands,
   generated PDF refresh and inverse SyncTeX. In the remote mobile Files view,
   verify notebook preview is inert and read-only; remote execution is absent.

Automated coverage: `code-provider.test.ts`, `notebook-kernels.test.ts` (when Jupyter is installed), `notebook-routes.test.ts`, `notebook-format.test.ts`, and
`e2e/notebook.test.ts`; the existing compilation and LaTeX suites cover shared
orchestration and command settings. Notebook execution uses Jupyter's
[kernel manager API](https://jupyter-client.readthedocs.io/en/stable/api/jupyter_client.html#jupyter_client.manager.KernelManager) and [notebook client](https://nbclient.readthedocs.io/en/latest/client.html)
and preserves the [version 4 notebook format](https://nbformat.readthedocs.io/en/latest/format_description.html).
