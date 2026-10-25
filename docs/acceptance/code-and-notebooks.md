# Code files and notebooks

Run against a daemon started from a plain shell, locally and over SSH. Tool
discovery and execution must occur on that host, using protocol 25.1 or newer.

1. Open a Python file with a visible print statement. With Python installed,
   the tab offers **Run in terminal** and **Compilation Settings…**, with only the
   **When clicked** command. No lightning control appears. Edit without saving,
   then run: the edit is saved first and a new terminal opens beside the source.
   Read input with `input()`, answer in the terminal and verify the reply.
   After exit, use the shell prompt. Interrupt a loop with Ctrl+C and use the
   prompt again. Resume the terminal: the programme must not replay.
   Change a file on disk: it must never execute automatically.
2. Repeat with C and C++ using the host's `cc`/`c++`, Clang or GCC. Use command
   settings to select a second installed compiler and add standard/include/link
   flags while retaining `{{binary}}`. Verify the programme runs after a
   successful build, with compiler output and programme input/output in the same
   terminal. Introduce a syntax error: show compiler output and the
   exit status in the new terminal, and never execute an old binary. Use a filename and
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
   preserves its old output and execution count. Double-click Markdown to edit
   in Monaco and press Command/Ctrl+Enter to render. Change the cell language,
   insert, duplicate, split and merge cells; undo structural changes from the
   cell container. Verify syntax highlighting and cursor retention while scrolling. Verify draft restoration and
   stale-file reconciliation after another editor changes the file. A malformed
   notebook shows a repair message and remains accessible in source view.
6. With `jupyter-nbconvert` and the notebook's kernel installed, use **Run to Executed Copy** from the notebook menu. An executed copy opens
   and the source's saved outputs stay unchanged. On protocol 25.2, header
   **Run All** and the open-tab play button update results inline instead. Run `counter = globals().get("counter", 0) + 1`
   followed by `print(counter)` twice: results are 1 and 2, with continuing
   execution counts. Close/reopen the source tab and reconnect the browser:
   another run returns 3. A different notebook starts with its own state.
   Missing kernels/imports and failing cells retain the last successful result.
7. Create a new `.ipynb` from the file tree and save a blank untitled draft as
   `.ipynb`: both open as valid empty notebooks. Saving an existing notebook as
   empty JSON source must remain literal. Put a `.venv` in the project and a
   Conda/Mamba environment in a conventional host location: both appear in
   **Select Python environment**, including when `ipykernel` is missing. Select
   an incomplete one: installation is offered and no package changes occur until
   clicking **Install**. Verify failure (for example, missing pip) stays visible;
   install successfully and run `import sys; print(sys.executable)` to verify the
   exact environment. Repeat with a custom folder and executable path containing
   spaces, a `~` path and a notebook-relative path. Check without global nbconvert.
   Switch environments: variables reset; reconnect: the selection remains. Check
   that no host kernelspec was created or overwritten. Older hosts retain the
   registered-kernel picker without environment requests.
8. Select an installed kernel from the header; verify the kernelspec edit is
   saved through ordinary notebook saving. **Restart kernel** starts fresh;
   **Shut down kernel** stops it, and the next explicit run starts a new one.
   Interrupt an endless loop; the current run fails and earlier variables remain
   available. A kernel that exits reports dead and requires Restart; it must not
   replay the interrupted source. Verify daemon shutdown and abrupt daemon exit
   leave no child kernels. Repeat shutdown while a kernel is starting.
9. Use header Code/Markdown and the raw-cell menu: each new cell is revealed and
   focused. Clear All Outputs removes execution counts/results without changing
   source, cell ids or other metadata; undo and saving still work. Outline
   entries reveal the matching cells. Confirm header controls wrap in narrow
   panes without obscuring notebook content. Generate is intentionally absent.

10. Inspect `.puddle/code/<provider>/<source-hash>/`: outputs and binaries stay
   under this source root. Live terminal runs remain available even after more
   than five runs; exiting those terminals leaves five recent completed runs.
   Run a programme for more than two minutes, reconnect and verify input still
   works. Exercise terminal kill and daemon shutdown. Notebook output limits
   interrupt the active execution while retaining the kernel. No programming-
   language run opens a text-output artefact or offers the old captured-output
   behaviour. Older daemon/client majors require the normal handshake upgrade.
11. Verify LaTeX still has both manual and eager controls, custom commands,
   generated PDF refresh and inverse SyncTeX. In the remote mobile Files view,
   verify notebook preview is inert and read-only; remote execution is absent.

Automated coverage: `code-terminal.test.ts`, `code-provider.test.ts`, `notebook-kernels.test.ts` (when Jupyter is installed), `notebook-routes.test.ts`, `notebook-environments.test.ts`, `notebook-format.test.ts`, and
`e2e/notebook.test.ts`; the existing compilation and LaTeX suites cover shared
orchestration and command settings. Notebook execution uses Jupyter's
[kernel manager API](https://jupyter-client.readthedocs.io/en/stable/api/jupyter_client.html#jupyter_client.manager.KernelManager) and [notebook client](https://nbclient.readthedocs.io/en/latest/client.html)
and preserves the [version 4 notebook format](https://nbformat.readthedocs.io/en/latest/format_description.html).

12. On protocol 25.2, run an individual cell, all above and this cell and below.
    Verify exact document order, shared variables, live stdout and execution counts.
    Edit or reorder a running cell: its output follows its id and source changes
    remain visible. Delete or convert a running cell: output never recreates it.
    Clear output, save and reopen: completed results stay cleared.
13. Run a failing cell followed by a mutation: display its traceback and skip the
    mutation. Interrupt a long batch: cancel queued cells and retain variables.
    Answer input() and getpass prompts; reject stale replies after interruption
    or restart. Reconnect during execution and confirm it is observed, never replayed.
    Remote profile leases must deny execute, execution and input operations.
