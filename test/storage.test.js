'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const MarkerStore = require('../lib/MarkerStore');
const SampleBuffer = require('../lib/SampleBuffer');
const TimelineStore = require('../lib/TimelineStore');
const { TIERS } = require('../lib/constants');

describe('SampleBuffer', () => {

  it('keeps a constant footprint while overwriting the oldest samples', () => {
    const buffer = new SampleBuffer(10);
    for (let index = 0; index < 25; index += 1) buffer.push(index * 1000, index, index, index, index);

    assert.equal(buffer.length, 10);
    assert.equal(buffer.firstTime(), 15000);
    assert.equal(buffer.lastTime(), 24000);
    assert.equal(buffer.bytes, 240);
  });

  it('preserves spikes when decimating', () => {
    const buffer = new SampleBuffer(100);
    for (let index = 0; index < 100; index += 1) {
      const spike = index === 42 ? 9000 : 100;
      buffer.push(index * 1000, spike, 0, spike, spike);
    }

    const series = buffer.read(0, 100000, 10);
    assert.equal(series.t.length, 10);
    assert.equal(Math.max(...series.peak), 9000, 'the spike survives decimation');
    assert.ok(Math.max(...series.consumption) < 9000, 'while the averaged series is smoothed');
  });

  it('survives a JSON round trip', () => {
    const buffer = new SampleBuffer(5);
    for (let index = 0; index < 5; index += 1) buffer.push(index * 1000, index * 10, index, index * 9, index * 11);

    const restored = new SampleBuffer(5);
    restored.fromJSON(buffer.toJSON());

    assert.equal(restored.length, 5);
    assert.deepEqual(restored.sampleAt(3), buffer.sampleAt(3));
  });

});

describe('TimelineStore', () => {

  const fill = (store, hours, interval = 5000) => {
    const end = Date.now();
    for (let t = end - hours * 3600 * 1000; t <= end; t += interval) {
      store.ingest({ t, consumption: 500, solar: 200, net: 300 });
    }
    return end;
  };

  it('serves short windows from the live tier and long windows from coarse tiers', () => {
    const store = new TimelineStore();
    const end = fill(store, 8);

    assert.equal(store.query({ from: end - 15 * 60 * 1000, to: end, maxPoints: 400 }).tier, 'live');
    assert.equal(store.query({ from: end - 6 * 3600 * 1000, to: end, maxPoints: 400 }).tier, 'mid');
    assert.equal(store.query({ from: end - 24 * 3600 * 1000, to: end, maxPoints: 400 }).tier, 'day');
  });

  it('never returns more points than requested', () => {
    const store = new TimelineStore();
    const end = fill(store, 2);

    for (const maxPoints of [20, 60, 240]) {
      const result = store.query({ from: end - 3600 * 1000, to: end, maxPoints });
      assert.ok(result.count <= maxPoints + 1, `${result.count} <= ${maxPoints} (+ live bucket)`);
    }
  });

  it('stays within its pre-allocated memory budget', () => {
    const store = new TimelineStore();
    fill(store, 48);

    const expected = TIERS.reduce((total, tier) => total + tier.capacity * 24, 0);
    assert.equal(store.bytes, expected);
    assert.ok(store.bytes < 128 * 1024, 'the whole timeline fits in 128 kB');
  });

  it('restores a snapshot and rejects a foreign one', () => {
    const store = new TimelineStore();
    fill(store, 12);

    const snapshot = JSON.parse(JSON.stringify(store.toJSON()));
    const restored = new TimelineStore();

    assert.equal(restored.fromJSON(snapshot), true);
    assert.ok(restored.oldest <= Date.now() - 11 * 3600 * 1000);
    assert.equal(restored.fromJSON({ version: 1, tier: 'day', interval: 1234, data: {} }), false);
    assert.equal(restored.fromJSON(null), false);
  });

});

describe('MarkerStore', () => {

  it('caps on count and on age', () => {
    const store = new MarkerStore({ capacity: 12, retentionMs: 60 * 1000 });
    const now = Date.now();

    for (let index = 0; index < 40; index += 1) {
      store.add({ t: now - (40 - index) * 1000, type: 'device_on', label: `Device ${index}`, deviceId: `d${index}` });
    }
    assert.equal(store.length, 12);

    store.add({ t: now - 10 * 60 * 1000, type: 'custom', label: 'ancient' });
    assert.equal(store.list({ types: ['custom'] }).length, 0);
  });

  it('suppresses an identical marker inside the dedupe window', () => {
    const store = new MarkerStore({ dedupeMs: 5000 });
    const now = Date.now();

    assert.ok(store.add({ t: now, type: 'device_on', label: 'Boiler on', deviceId: 'b' }));
    assert.equal(store.add({ t: now + 1000, type: 'device_on', label: 'Boiler on', deviceId: 'b' }), null);
    assert.ok(store.add({ t: now + 9000, type: 'device_on', label: 'Boiler on', deviceId: 'b' }));
  });

  it('keeps markers sorted when they arrive out of order', () => {
    const store = new MarkerStore();
    const now = Date.now();

    store.add({ t: now, type: 'custom', label: 'second' });
    store.add({ t: now - 5000, type: 'custom', label: 'first' });

    assert.deepEqual(store.list().map((marker) => marker.label), ['first', 'second']);
  });

});
