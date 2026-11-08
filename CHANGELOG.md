<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Frontend

#### Changed

- Enabling Ripple starts its handle at the bottom with output and input covered; disabling it starts at the top for full CLI. Manual placement remains available on desktop and mobile.
- Use frontend terminology throughout the application, documentation and future releases while retaining compatibility with published versions.

#### Fixed

- Cover the native terminal's leftmost column in Ripple so prompt markers and input do not appear twice when the handle is dragged to the bottom, on desktop and mobile.
- Refresh cached website favicons, installed web app icons and notification icons to use the new Puddle logo set.

### Daemon

#### Added

- Add preparatory huddle document validation and bounded source discovery for independent project definitions, including typed settings and bounded feedback graphs; runtime and UI enablement remain pending.

### Runtime

#### Added

- Define huddle event/readout contracts and an internal node execution boundary with validated ports, immutable inputs and acknowledged emissions, ahead of independent owner integration.
- Add a private huddle execution ledger with atomic trigger cursors, node routing, retained budgets and outcome reservations; preserve consumed operations through process loss without redispatch.
- Add durable huddle graph routing with correlated joins, explicit event fan-out and bounded coder/reviewer feedback; keep worker/service integration pending.
- Add isolated huddle script workers with captured multi-file imports, shared puddlang agent calls, bounded transport and cancellation; include the helper modules and smoke check in host archives.
- Persist immutable huddle revisions and exact activation bindings, and schedule manual graphs through isolated workers with bounded feedback, durable results and cancellation; independent owner-service integration remains pending.
