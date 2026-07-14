# The puddle communication protocol

`@puddle/shared` is the protocol package: the zod schemas in `src/` are the
single, executable description of every REST shape and WebSocket message
exchanged between the `puddle` CLI (and the UI it serves) and `puddled`. There
is deliberately no prose copy of the schema — prose copies drift. This file
only defines how the protocol is versioned. The full design is SPEC §6,
"Protocol versioning and compatibility".

## Two version numbers

- **App version** — the npm/tarball semver. Says nothing about compatibility.
- **Protocol version** — `PROTOCOL_VERSION = {major, minor}` in
  `src/protocol.ts`, reported by `GET /api/version`. This is the
  compatibility contract.

## The rule

**Same `major` ⇒ compatible, in both directions.** Everything within a major
is additive-only. When the CLI's handshake sees a `major` mismatch it updates
the daemon automatically (or, if the daemon is newer, tells the user to update
the CLI). There are no compatibility shims: old majors are not served.

## When you change a schema in this package

| Change                                                       | Action                      |
| ------------------------------------------------------------ | --------------------------- |
| New endpoint, new WS message type                            | bump `minor`                |
| New **optional** request/response field                      | bump `minor`                |
| New enum value that peers may safely ignore                  | bump `minor`                |
| Removing or renaming an endpoint, field, or WS message       | bump `major`, reset `minor` |
| Changing a field's type, or the meaning of an existing value | bump `major`, reset `minor` |
| Changing auth, the token flow, or the WS handshake           | bump `major`, reset `minor` |
| Comment/doc-only edits, refactors with identical wire shapes | no bump                     |

Bump the constant **in the same commit** as the schema change, and note the
bump in `CHANGELOG.md`.

## Wire rules that keep additive changes safe

1. Receivers **ignore unknown WS message types** (an unrecognised `t` is
   dropped, not an error).
2. Receivers **tolerate unknown JSON fields** — schemas use loose objects
   wherever extension is expected.
3. A newer client on an older daemon **feature-detects** against the daemon's
   `minor` and hides what the daemon cannot do; it must not fail.
