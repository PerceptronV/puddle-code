import { describe, expect, it } from 'vitest';
import {
  availableHostUpdates,
  HostUpdateOffers,
  reviewedApply,
} from '../../src/features/host-updates/model';
import { reviewFixture, statusFixture } from './fixtures';

describe('host update offers', () => {
  it('compares components independently without imposing cockpit release equality', () => {
    const status = statusFixture();
    expect(availableHostUpdates(status)).toEqual([
      { component: 'daemon', version: '0.4.1' },
      { component: 'runtime', version: '0.4.1' },
    ]);
    status.catalogue!.daemon_version = '0.5.0';
    expect(availableHostUpdates(status)).toEqual([{ component: 'runtime', version: '0.4.1' }]);
    status.catalogue!.runtime_default!.version = '0.4.1';
    expect(availableHostUpdates(status)).toEqual([]);
  });

  it('retains known offline releases but never guesses unknown versions or missing packages', () => {
    const status = statusFixture();
    status.catalogue!.releases.state = 'failed';
    expect(availableHostUpdates(status)).toHaveLength(2);
    status.catalogue!.runtime_default = null;
    status.catalogue!.daemon_version = 'dev';
    expect(availableHostUpdates(status)).toEqual([]);
    status.catalogue!.daemon_version = '0.4.0';
    status.catalogue!.releases.latest!.host_asset = false;
    expect(availableHostUpdates(status)).toEqual([]);
    status.catalogue!.releases.latest!.host_asset = true;
    status.availability = 'unavailable';
    expect(availableHostUpdates(status)).toEqual([]);
    delete status.catalogue;
    expect(availableHostUpdates(status)).toEqual([]);
  });

  it('offers once per host/component/release/window across polls and reconnects', () => {
    const offers = new HostUpdateOffers();
    const targets = availableHostUpdates(statusFixture());
    expect(offers.take('host-a', targets)).toHaveLength(2);
    expect(offers.take('host-a', [])).toEqual([]);
    expect(offers.take('host-a', targets)).toEqual([]);
    expect(offers.take('host-b', targets)).toHaveLength(2);
    expect(new HostUpdateOffers().take('host-a', targets)).toHaveLength(2);
    expect(offers.take('host-a', [{ component: 'daemon', version: '0.4.2' }])).toHaveLength(1);
    expect(offers.take('host-a', targets)).toEqual([]);
  });
});

describe('reviewed activation', () => {
  it('binds explicit apply to the reviewed operation and revision', () => {
    const status = statusFixture();
    const reply = reviewFixture();
    status.result = reply;
    expect(reviewedApply(status, reply)).toEqual({
      action: 'apply',
      reference: { id: reply.operation!.id, revision: 3 },
      fingerprint: 'a'.repeat(64),
    });
    status.result = { ok: false, code: 'unavailable', operation: reply.operation };
    expect(reviewedApply(status, reply)).toBeNull();
    status.result = { ...reply, operation: { ...reply.operation!, revision: 4 } };
    expect(reviewedApply(status, reply)).toBeNull();
    status.result.operation!.id = '22222222-2222-4222-8222-222222222222';
    status.result.operation!.revision = 3;
    expect(reviewedApply(status, reply)).toBeNull();
  });

  it('requires supported exact interruption approval and refuses blocked/dispatched reviews', () => {
    const status = statusFixture();
    const reply = reviewFixture(true);
    status.result = reply;
    expect(reviewedApply(status, reply)?.interruption_approval).toBe('b'.repeat(64));
    status.capabilities.interruption_approval = false;
    expect(reviewedApply(status, reply)).toBeNull();
    status.capabilities.interruption_approval = true;
    delete reply.review!.interruption_fingerprint;
    expect(reviewedApply(status, reply)).toBeNull();
    reply.review!.can_apply = true;
    reply.review!.fingerprint = 'a'.repeat(64);
    reply.operation!.dispatched = true;
    expect(reviewedApply(status, reply)).toBeNull();
    reply.operation!.dispatched = false;
    status.availability = 'unavailable';
    expect(reviewedApply(status, reply)).toBeNull();
  });
});
