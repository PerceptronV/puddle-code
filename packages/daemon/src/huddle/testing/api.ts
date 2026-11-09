import type { PuddlangClient } from '../../puddlang/client.js';

let client: PuddlangClient | undefined;
export function setFixtureClient(value: PuddlangClient) {
  client = value;
}
export function fixtureClient(): PuddlangClient {
  if (!client) throw new Error('Fixture has not started');
  return client;
}
