import { expect, it } from 'vitest';
import { notificationOptions } from '../src/notification-options.js';

it('keeps Windows text literal instead of allowing notification XML injection', () => {
  const options = notificationOptions(
    {
      id: 'example',
      title: 'Host & project',
      subtitle: '</text><text>Injected title',
      body: 'Compare a < b and c > d. "Quoted" text stays intact.',
    },
    'win32',
  );
  expect(options.toastXml).toBe(
    '<toast><visual><binding template="ToastGeneric">' +
      '<text>Host &amp; project</text>' +
      '<text>&lt;/text&gt;&lt;text&gt;Injected title</text>' +
      '<text>Compare a &lt; b and c &gt; d. "Quoted" text stays intact.</text>' +
      '</binding></visual><audio silent="true"/></toast>',
  );
});

it.each(['darwin', 'win32', 'linux'] as const)(
  'preserves subtitle-free test and legacy notifications on %s',
  (platform) => {
    expect(
      notificationOptions({ id: 'test', title: 'Puddle', body: 'Test notification' }, platform),
    ).toEqual({
      title: 'Puddle',
      body: 'Test notification',
      silent: true,
    });
  },
);
