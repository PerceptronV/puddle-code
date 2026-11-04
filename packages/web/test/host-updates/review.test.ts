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
      createElement(OperationReview, { status, reply, disabled: false, act: () => {} }),
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
      createElement(OperationReview, { status, reply, disabled: false, act: () => {} }),
    );
  expect(render()).toContain('Continue recovery');
  expect(render()).toContain('Verify completion');
  expect(render()).not.toContain('Apply update');
  status.capabilities.continue_recovery = false;
  status.capabilities.verify_completion = false;
  expect(render()).not.toContain('Continue recovery');
  expect(render()).not.toContain('Verify completion');
});
