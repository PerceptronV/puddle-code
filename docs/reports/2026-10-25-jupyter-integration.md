# Jupyter integration audit — 25 October 2026

Puddle has a real Jupyter kernel frontend. Before this change it did **not** have
interactive widget support: the renderer recognised widget MIME data but displayed
a placeholder, and the daemon did not retain or route widget comms between runs.
The implementation now connects the official Jupyter widget manager to persistent
kernel comms, including binary data and callback output. It does not implement the
whole Jupyter Server or JupyterLab application.

## What is integrated

| Area | Behaviour |
| --- | --- |
| Kernel lifecycle | One daemon-owned kernel per canonical notebook; explicit restart, shutdown and interrupt; variables survive cell runs and browser reconnects. |
| Execution | Cell/range/all execution, streamed results, execution counts, errors, output updates and separate executed copies. Source edits and results merge by stable cell id. |
| Input | Jupyter stdin requests appear inside cell output, with Enter submission, masked passwords and Ctrl+C interruption. This is a request/reply protocol, not a PTY. |
| Editor assistance | Completion and inspection query an existing idle kernel without starting one. |
| Notebook files | Version 4 notebooks, metadata, attachments, shared JSON editing/drafts and normal save/conflict handling. |
| Widget models and views | Official `@jupyter-widgets/html-manager`, locally bundled core controls, layout/style models and linked model references. Widget MIME takes priority over plain text. |
| Live widget interaction | Persistent comm open/message/close routing, trait patches, custom messages, binary buffers and Python callbacks after cell execution finishes. |
| Output widgets | Persistent capture, later-cell reuse, direct output assignment, stream/error/rich output, clear/wait and display-id updates. Execution clients suppress duplicate capture. |
| Persistence | Standard widget-state v2 metadata with base64 buffers, including executed copies. Saved core models render without starting a kernel. |
| Custom widgets | Compatible public AMD widget modules load from their declared npm package/version at the standard `dist/index.js` entry point. Saved custom widgets require an explicit Load action. |

## Boundaries

- There is no Jupyter Server REST/Contents/Sessions API or attachment to an
  independently running Jupyter server/kernel. Puddle owns kernel startup through
  Jupyter's client APIs.
- Puddle is not a JupyterLab extension host. Lab-only/federated extensions, custom
  server APIs, private module registries, debugger UI and arbitrary non-widget comm
  targets are not provided. A working core widget manager does not imply that every
  third-party widget package will work.
- The selected kernel must already contain `ipywidgets` and any required Python
  widget package. Merely opening a notebook does not install Python packages.
- Widgets run only in the local/SSH cockpit. Remote/mobile notebook previews remain
  inert, and both widget operations are denied by connector and profile authority.
- Ordinary HTML/JavaScript MIME outputs remain sanitised/inert. Script execution is
  confined to an opaque-origin widget frame; the parent provides only validated
  widget comm access, without credentials or notebook execution APIs. Live custom
  modules can access the network from that frame. Opening saved custom modules is
  an explicit action.
- Bounds remain deliberate: 1,024 models, 4 MiB retained state, 2 MiB per message,
  and 256 events / 2 MiB history. History gaps restore the current model graph;
  transient custom events are not replayed. Oversized state fails visibly and needs
  a kernel restart. The editor also reports when widget metadata exceeds its
  notebook save limit.
- Saved widgets are disconnected. Browser-only interactions may change their view,
  but Python callbacks require a live kernel. Reloading the view never re-executes
  cells or repeats previous actions.
- General rich-output parity is broader than widgets: specialised MIME renderers,
  unrestricted asynchronous ordinary-cell output and the complete JupyterLab
  notebook interaction model are not claimed by this work.

## Verification

Real-kernel tests used `ipywidgets 8.1.8`, `nbclient 0.11.0` and
`jupyter_client 8.6.3`; the bundled HTML manager is `1.0.15`.

`packages/daemon/test/notebook-widgets.test.ts` checks bounded snapshots and event
history, binary trait replacement, real trait updates and button callbacks, Output
reuse and deferred clearing, display-id updates, executed-copy metadata, and
rejection of writes against a retired kernel generation.

`packages/web/e2e/notebook-widgets.test.ts` uses Chromium and a real isolated kernel
without launching `puddled`. It verifies nested controls and `jslink`, Python
callbacks, FileUpload byte integrity, binary Image rendering, a custom Python/AMD
widget, saving and reload, live reconnection, saved rendering after shutdown,
explicit saved-extension loading and the iframe sandbox. The custom extension's
CDN response is supplied by the test, so this proves module loading and comms,
not availability or compatibility of every public package.

Existing notebook browser tests retain cell editing, inline input, interruption,
stale-result handling and assistance coverage. Protocol gating and remote denial
tests cover the new endpoints. Production web building and TypeScript/lint checks
cover the bundled renderer. Manual local/SSH acceptance is listed in
`docs/acceptance/code-and-notebooks.md`.

## Upstream contracts

The integration follows the [Jupyter messaging protocol](https://jupyter-client.readthedocs.io/en/latest/messaging.html),
the [widget comm protocol](https://github.com/jupyter-widgets/ipywidgets/blob/main/packages/schema/messages.md)
and the [widget model/view architecture](https://ipywidgets.readthedocs.io/en/8.1.3/examples/Widget%20Low%20Level.html).
The upstream widget manager owns model deserialisation, views and core controls;
Puddle owns lifecycle, bounded transport, persistence and isolation.
