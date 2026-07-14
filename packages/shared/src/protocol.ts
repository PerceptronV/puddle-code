/**
 * The communication-protocol version — NOT the app version (SPEC §6,
 * "Protocol versioning and compatibility").
 *
 * Same `major` ⇒ CLI/UI and daemon are compatible in both directions; a
 * `major` mismatch makes the CLI update the daemon automatically. Bump rules
 * live in PROTOCOL.md at this package's root — read it before changing any
 * schema in this package.
 */
export const PROTOCOL_VERSION = { major: 3, minor: 5 } as const;
