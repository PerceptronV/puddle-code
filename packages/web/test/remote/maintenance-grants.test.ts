import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { RemoteDevice } from '@puddle/shared';
import { DeviceList } from '../../src/features/settings/remote-access/DeviceList';
import { BrowserCards } from '../../src/features/remote/BrowserCards';

const device: RemoteDevice = {
  id: '11111111-1111-4111-8111-111111111111',
  peer: '12D3KooW' + 'a'.repeat(44),
  account: 'owner',
  label: 'Phone',
  status: 'approved',
  created: 1000,
  lastUsed: 1000,
  expires: 50_000,
};
const render = (canManageMaintenance: boolean, change: Partial<RemoteDevice> = {}) =>
  renderToStaticMarkup(
    createElement(DeviceList, {
      devices: [{ ...device, ...change }],
      now: 2000,
      busy: false,
      canManageMaintenance,
      act: async () => true,
    }),
  );

it('shows host maintenance controls only for a capable local/SSH cockpit and approved active browser', () => {
  expect(render(false)).not.toContain('Allow host maintenance');
  expect(render(true)).toContain('Allow host maintenance for Phone');
  expect(render(true)).toContain('Updates can affect every profile');
  expect(render(true, { maintenance: true })).toContain('Revoke host maintenance for Phone');
  expect(render(true, { status: 'pending' })).not.toContain('Allow host maintenance for Phone');
  expect(render(true, { expires: 1500 })).not.toContain('Allow host maintenance for Phone');
});

it('does not offer grant changes from ordinary paired-browser cards', () => {
  const html = renderToStaticMarkup(
    createElement(BrowserCards, {
      devices: [{ ...device, maintenance: true }],
      now: 2000,
      busy: false,
      approve: () => {},
      revoke: () => {},
    }),
  );
  expect(html).not.toContain('Allow host maintenance');
  expect(html).not.toContain('Revoke host maintenance');
});
