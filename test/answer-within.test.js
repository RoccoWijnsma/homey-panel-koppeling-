'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { answerWithin } = require('../lib/answer-within');

/**
 * A timer the test fires by hand, so "the cap ran out" is a decision rather
 * than a wait. Returns the harness plus a `fire` to trip the pending timer.
 */
function fakeTimers() {
  const pending = new Map();
  let next = 1;

  return {
    setTimeout: (fn) => {
      const id = next;
      next += 1;
      pending.set(id, fn);
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
    /** @returns {number} How many timers are still armed. */
    get armed() {
      return pending.size;
    },
    fire() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
  };
}

/**
 * @param {object} [overrides]
 */
function harness(command, overrides = {}) {
  const timers = fakeTimers();
  const failures = [];
  let slow = 0;

  const promise = answerWithin(command, {
    ms: 2500,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onFailure: (err) => failures.push(err),
    onSlow: () => {
      slow += 1;
    },
    ...overrides,
  });

  return { promise, timers, failures, slowCalls: () => slow };
}

describe('answering a slow command', () => {
  it('answers on the command when it finishes in time', async () => {
    const { promise, timers, failures, slowCalls } = harness(Promise.resolve('done'));

    await promise;

    assert.equal(slowCalls(), 0, 'the cap should not have been what answered');
    assert.deepEqual(failures, []);
    assert.equal(timers.armed, 0, 'the timer should have been cleared');
  });

  it('reports a failure that arrives in time', async () => {
    const boom = new Error('no home key');
    const { promise, timers, failures } = harness(Promise.reject(boom));

    await assert.rejects(promise, /no home key/);

    assert.deepEqual(failures, [boom], 'the failure should also be reported once');
    assert.equal(timers.armed, 0);
  });

  it('answers anyway once the cap runs out', async () => {
    // A command that never settles stands in for a radio that is still busy.
    const { promise, timers, failures, slowCalls } = harness(new Promise(() => {}));

    timers.fire();
    await promise;

    assert.equal(slowCalls(), 1, 'the caller should have been told the radio is slow');
    assert.deepEqual(failures, []);
  });

  it('reports a late failure without breaking the answer already given', async () => {
    let fail;
    const command = new Promise((_, reject) => {
      fail = reject;
    });
    const { promise, timers, failures } = harness(command);

    timers.fire();
    await promise; // Already answered: the write was accepted.

    const boom = new Error('connection lost');
    fail(boom);
    await new Promise((resolve) => setImmediate(resolve));

    // The only channel a late failure has is onFailure - and it must not turn
    // into an unhandled rejection, which would take the app down.
    assert.deepEqual(failures, [boom]);
    await promise;
  });

  it('lets the command finish after answering early', async () => {
    // Answering early must not abandon the work: the shade has to keep moving
    // after the caller has been told the write was accepted.
    let finish;
    let ran = false;
    const command = new Promise((resolve) => {
      finish = () => {
        ran = true;
        resolve();
      };
    });
    const { promise, timers } = harness(command);

    timers.fire();
    await promise;
    assert.equal(ran, false, 'the command should still be in flight');

    finish();
    await command;
    assert.equal(ran, true, 'the command should have run to completion');
  });
});
