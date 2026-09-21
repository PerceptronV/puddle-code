import { expect, it } from 'vitest';
import { readConfig } from '../src/config.js';

const env = {
  PUDDLE_REMOTE_SERVICE: 'https://relay.example.com',
  PUDDLE_REMOTE_APP: 'https://app.example.com',
  BETTER_AUTH_SECRET: 'isolated-test-secret-long-enough-for-auth',
};

it('requires a complete Google or GitHub configuration without mail settings', () => {
  expect(() => readConfig(env)).toThrow('at least one OAuth provider');
  for (const name of ['GOOGLE', 'GITHUB']) {
    expect(() => readConfig({ ...env, [`${name}_CLIENT_ID`]: 'id' })).toThrow(
      'both OAuth credentials',
    );
    expect(() => readConfig({ ...env, [`${name}_CLIENT_SECRET`]: 'secret' })).toThrow(
      'both OAuth credentials',
    );
    const config = readConfig({
      ...env,
      [`${name}_CLIENT_ID`]: 'id',
      [`${name}_CLIENT_SECRET`]: 'secret',
    });
    expect(config[name === 'GOOGLE' ? 'google' : 'github']).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
    });
    expect(config.openSignup).toBe(false);
    expect(config.signupEmails).toEqual([]);
  }
});
