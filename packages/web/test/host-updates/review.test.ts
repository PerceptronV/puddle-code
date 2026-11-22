import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { OperationReview } from '../../src/features/host-updates/OperationReview';
import { reviewFixture, statusFixture } from './fixtures';

it('shows exact interruption impact before the explicit destructive action', () => {
  const status = statusFixture();
  const reply = reviewFixture(true);
  status.result = reply;
  const render = () =>
    renderToStaticMarkup(
      createElement(OperationReview, {
        status,
        reply,
        disabled: false,
        offlineDisabled: false,
        act: () => {},
      }),
    );
  let html = render();
  expect(html).toContain('2 terminals, 1 notebook kernels');
  expect(html).toContain('Interrupt listed work and apply');
  expect(html).toContain('in-memory kernel state will be lost');
  reply.operation!.revision++;
  status.result = { ...reply, operation: { ...reply.operation!, revision: 5 } };
  html = render();
  expect(html).not.toContain('Interrupt listed work and apply');
  expect(html).toContain('Review impact');
});

it('offers explicit supported recovery without offering apply again', () => {
  const status = statusFixture();
  const reply = reviewFixture();
  reply.operation!.phase = 'recovery_required';
  reply.operation!.dispatched = true;
  status.result = reply;
  const render = () =>
    renderToStaticMarkup(
      createElement(OperationReview, {
        status,
        reply,
        disabled: false,
        offlineDisabled: false,
        act: () => {},
      }),
    );
  expect(render()).toContain('Continue recovery');
  expect(render()).toContain('Verify completion');
  expect(render()).not.toContain('Apply update');
  status.capabilities.continue_recovery = false;
  status.capabilities.verify_completion = false;
  expect(render()).not.toContain('Continue recovery');
  expect(render()).not.toContain('Verify completion');
});

it('keeps offline recovery separate from disabled live controls', () => {
  const status = statusFixture();
  const reply = reviewFixture();
  reply.operation!.phase = 'recovery_required';
  reply.operation!.dispatched = true;
  status.result = reply;
  status.availability = 'unavailable';
  status.observation = 'recorded';
  status.capabilities = {
    interruption_approval: false,
    verify_completion: false,
    continue_recovery: false,
    offline_continuation: true,
  };
  const render = (offlineDisabled: boolean) =>
    renderToStaticMarkup(
      createElement(OperationReview, {
        status,
        reply,
        disabled: true,
        offlineDisabled,
        act: () => {},
      }),
    );
  expect(render(false)).toContain('Continue recovery on host');
  expect(render(false)).not.toContain('disabled=');
  expect(render(false)).not.toContain('Verify completion');
  expect(render(true)).toContain('disabled=');
});

it('uses frontend terminology for incompatibility reported by an older host', () => {
  const status = statusFixture();
  const reply = reviewFixture();
  reply.review!.blockers = [{ code: 'cockpit_incompatible', target: 'cockpit' }];
  reply.review!.can_apply = false;
  status.result = reply;
  const html = renderToStaticMarkup(
    createElement(OperationReview, {
      status,
      reply,
      disabled: false,
      offlineDisabled: false,
      act: () => {},
    }),
  );
  expect(html).toContain('Check failed: frontend incompatible');
  expect(html).not.toContain('cockpit');
});

it('shows live recovery blockers from status without reusing an old approval or exposing targets', () => {
  const status = statusFixture();
  const oldApproval = reviewFixture();
  const current = reviewFixture();
  current.operation!.phase = 'recovery_required';
  current.operation!.dispatched = true;
  current.review!.fingerprint = null;
  current.review!.can_apply = false;
  current.review!.blockers = [
    { code: 'runtime_persistence_pending', target: '/private/first' },
    { code: 'runtime_persistence_pending', target: '/private/second' },
  ];
  status.result = current;
  const render = () =>
    renderToStaticMarkup(
      createElement(OperationReview, {
        status,
        reply: oldApproval,
        disabled: false,
        offlineDisabled: false,
        act: () => {},
      }),
    );
  const html = render();
  expect(html).toContain('2 affected runtimes');
  expect(html).toContain('cannot confirm saved state');
  expect(html).toContain('requires your approval');
  expect(html).toContain('without reinstalling');
  expect(html).not.toContain('/private');
  expect(html).not.toContain('Apply update');
  expect(html).not.toContain('Daemon-owned work affected');
  status.observation = 'recorded';
  expect(render()).not.toContain('2 affected runtimes');
  status.observation = 'live';
  delete current.review;
  expect(render()).not.toContain('2 affected runtimes');
});
