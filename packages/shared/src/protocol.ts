/**
 * The communication-protocol version — NOT the app version (SPEC §6,
 * "Protocol versioning and compatibility").
 *
 * Same `major` ⇒ CLI/UI and daemon are compatible in both directions; a
 * `major` mismatch makes the CLI update the daemon automatically. Bump rules
 * live in PROTOCOL.md at this package's root — read it before changing any
 * schema in this package.
 */
// 6.0 (2026-07-15): major bumped with no schema shape change, on purpose —
// forces every connected daemon to hit a major mismatch on the next handshake
// and auto-upgrade onto this release (see PROTOCOL.md, "The rule").
export const PROTOCOL_VERSION = { major: 6, minor: 0 } as const;
