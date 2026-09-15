'use strict';

const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

// Redirect `homey` and `homey-api` to the stubs before app.js is loaded, so the whole app can be
// booted in-process exactly as Homey would boot it.
const STUBS = {
  homey: path.join(__dirname, 'stubs/homey.js'),
  'homey-api': path.join(__dirname, 'stubs/homey-api.js'),
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...args) {
  if (STUBS[request]) return STUBS[request];
  return originalResolve.call(this, request, ...args);
};

const { FakeHomey } = require('./stubs/homey');
const { FakeDevice } = require('./stubs/homey-api');
const EnergyInsightsApp = require('../app');
const apiRoutes = require('../api');
const manifest = require('../app.json');

/** A small household: a P1 meter, an inverter, an air conditioner and a fridge. */
function buildHousehold() {
  return {
    meter: new FakeDevice({
      id: 'meter',
      name: 'P1 Smart Meter',
      class: 'sensor',
      capabilities: ['measure_power'],
      capabilitiesObj: { measure_power: { value: 400 } },
      energy: { cumulative: true },
    }),
    solar: new FakeDevice({
      id: 'solar',
      name: 'Solar Panels',
      class: 'solarpanel',
      capabilities: ['measure_power'],
      capabilitiesObj: { measure_power: { value: 0 } },
    }),
    ac: new FakeDevice({
      id: 'ac',
      name: 'Air Conditioning',
      class: 'airconditioning',
      capabilities: ['measure_power', 'onoff'],
      capabilitiesObj: { measure_power: { value: 0 }, onoff: { value: false } },
    }),
    fridge: new FakeDevice({
      id: 'fridge',
      name: 'Fridge',
      class: 'other',
      capabilities: ['measure_power'],
      capabilitiesObj: { measure_power: { value: 90 } },
    }),
  };
}

describe('EnergyInsightsApp', () => {

  let homey;
  let app;
  let devices;

  before(async () => {
    devices = buildHousehold();
    globalThis.__TEST_DEVICES__ = devices;

    homey = new FakeHomey();
    app = new EnergyInsightsApp(homey);
    homey.app = app;

    await app.onInit();
    await app.monitor.start();
  });

  after(async () => {
    await app.onUninit();
  });

  it('boots and finds every device that reports power', () => {
    assert.equal(app.monitor.devices.size, 4);
    assert.equal(app.monitor.get('meter').role, 'grid', 'a cumulative meter is the grid meter');
    assert.equal(app.monitor.get('solar').role, 'solar');
    assert.equal(app.monitor.get('ac').role, 'consumer');
    assert.deepEqual(app.errors, []);
  });

  it('registers a listener for every Flow card in the manifest', () => {
    // Only triggers with arguments need a run listener; the token-only ones are created lazily
    // the first time they fire, so they are covered by the peak and feed-in cases below.
    for (const id of ['power_peak_above', 'device_caused_spike']) {
      assert.ok(homey.cards.trigger.get(id)?.runListener, `${id} has no run listener`);
    }
    const withArguments = manifest.flow.triggers.filter((trigger) => trigger.args?.length);
    assert.deepEqual(
      withArguments.map((trigger) => trigger.id).sort(),
      ['device_caused_spike', 'power_peak_above'],
      'a trigger gained arguments but no run listener',
    );

    for (const condition of manifest.flow.conditions) {
      assert.ok(homey.cards.condition.get(condition.id)?.runListener, `${condition.id} has no run listener`);
    }
    for (const action of manifest.flow.actions) {
      assert.ok(homey.cards.action.get(action.id)?.runListener, `${action.id} has no run listener`);
    }
    assert.ok(homey.cards.trigger.get('device_caused_spike').autocompleteListeners.device);
  });

  it('samples the home into the timeline', () => {
    for (let index = 0; index < 20; index += 1) app._tick();

    const state = app.getState();
    assert.equal(state.hasGridMeter, true);
    assert.equal(state.net, 400, 'the grid meter is authoritative for net power');
    assert.equal(state.consumption, 400);
    assert.ok(state.unmetered > 0, 'the meter sees more than the two metered loads');
    assert.ok(app.timeline.liveTier.buffer.length > 0 || app.timeline.liveTier.accumulator);
  });

  it('marks a device switching on, and explains the peak it causes', () => {
    devices.ac.set('onoff', true);
    devices.ac.set('measure_power', 3300);
    devices.meter.set('measure_power', 3700);
    app._tick();

    const markers = app.markers.list();
    const deviceMarker = markers.find((marker) => marker.type === 'device_on');
    assert.ok(deviceMarker, 'the air conditioner switching on is annotated');
    assert.match(deviceMarker.label, /Air Conditioning turned on/);

    const peak = app.markers.latest('peak');
    assert.ok(peak, 'a peak is detected');
    assert.match(peak.reason, /Air Conditioning starting/);
    assert.equal(peak.deviceName, 'Air Conditioning');

    const fired = homey.triggered.map((entry) => entry.id);
    assert.ok(fired.includes('power_peak_above'));
    assert.ok(fired.includes('device_caused_spike'));
    assert.ok(fired.includes('marker_added'));

    const peakTrigger = homey.triggered.find((entry) => entry.id === 'power_peak_above');
    assert.equal(peakTrigger.state.watts, 3700);
    assert.match(peakTrigger.tokens.reason, /Air Conditioning/);
  });

  it('honours the threshold argument of the peak trigger', async () => {
    const card = homey.cards.trigger.get('power_peak_above');
    assert.equal(await card.runListener({ watts: 3000 }, { watts: 3700 }), true);
    assert.equal(await card.runListener({ watts: 5000 }, { watts: 3700 }), false);
  });

  it('answers the condition cards from the live state', async () => {
    assert.equal(await homey.cards.condition.get('usage_higher_than_solar').runListener({ margin: 0 }), true);
    assert.equal(await homey.cards.condition.get('is_feeding_in').runListener({}), false);
    assert.equal(await homey.cards.condition.get('series_above').runListener({ series: 'consumption', watts: 1000 }), true);
    assert.equal(await homey.cards.condition.get('series_above').runListener({ series: 'solar', watts: 1000 }), false);
  });

  it('adds a custom marker from the Flow action', async () => {
    const result = await homey.cards.action.get('add_marker').runListener({ label: 'Sauna', color: 'teal' });

    assert.equal(typeof result.watts, 'number');
    const marker = app.markers.latest('custom');
    assert.equal(marker.label, 'Sauna');
    assert.equal(marker.color, 'teal');
  });

  it('changes the peak threshold from the Flow action', async () => {
    await homey.cards.action.get('set_peak_threshold').runListener({ watts: 4200 });
    assert.equal(app.config.peakThreshold, 4200);
    assert.equal(homey.store.get('config').peakThreshold, 4200);
  });

  it('detects feed-in once the sun overtakes the load', () => {
    devices.ac.set('onoff', false);
    devices.ac.set('measure_power', 0);
    devices.solar.set('measure_power', 2600);
    devices.meter.set('measure_power', -2100);
    app._tick();

    assert.equal(app.getState().gridExport, 2100);
    assert.ok(app.markers.latest('feed_in_start'), 'feed-in is annotated');
    assert.ok(homey.triggered.some((entry) => entry.id === 'feed_in_started'));
  });

  it('serves the Web API the settings page and widget call', async () => {
    const state = await apiRoutes.getState({ homey });
    assert.equal(typeof state.consumption, 'number');

    const timeline = await apiRoutes.getTimeline({ homey, query: { points: 50 } });
    assert.ok(Array.isArray(timeline.series.t));
    assert.ok(Array.isArray(timeline.markers));

    const added = await apiRoutes.addMarker({ homey, body: { label: 'From the dashboard' } });
    assert.equal(added.label, 'From the dashboard');
    await assert.rejects(() => apiRoutes.addMarker({ homey, body: { label: '  ' } }), /needs a label/);

    const removed = await apiRoutes.deleteMarker({ homey, params: { id: added.id } });
    assert.equal(removed.removed, 1);
    await assert.rejects(() => apiRoutes.deleteMarker({ homey, params: { id: 'nope' } }), /not found/);

    const list = await apiRoutes.getDevices({ homey });
    assert.equal(list.devices.length, 4);

    await apiRoutes.setDeviceRole({ homey, params: { id: 'fridge' }, body: { role: 'ignore' } });
    assert.equal(app.monitor.get('fridge').role, 'ignore');
    assert.equal(homey.store.get('deviceRoles').fridge, 'ignore');

    const config = await apiRoutes.setConfig({ homey, body: { peakThreshold: 2500, nonsense: true } });
    assert.equal(config.peakThreshold, 2500);
    assert.equal(config.nonsense, undefined, 'unknown keys are dropped');

    const diagnostics = await apiRoutes.getDiagnostics({ homey });
    assert.equal(diagnostics.devices, 4);
    assert.ok(diagnostics.timelineBytes > 0);
  });

  it('clamps values that would hurt Homey', async () => {
    const config = await apiRoutes.setConfig({ homey, body: { sampleInterval: 0, markerCapacity: 99999 } });
    assert.equal(config.sampleInterval, 2, 'sampling never goes below two seconds');
    assert.equal(config.markerCapacity, 1000, 'markers never exceed the hard cap');
  });

  it('broadcasts to open dashboards without flooding them', () => {
    const events = homey.realtimeEvents.map((entry) => entry.event);
    assert.ok(events.includes('state'));
    assert.ok(events.includes('marker'));
  });

  it('persists a snapshot that fits in Homey settings', () => {
    homey.emit('unload');

    const snapshot = homey.store.get('snapshot');
    assert.ok(snapshot.timeline, 'the coarse tier is stored');
    assert.ok(Array.isArray(snapshot.markers.markers));
    assert.ok(JSON.stringify(snapshot).length < 256 * 1024);
  });

  it('restores that snapshot into a fresh app instance', async () => {
    const restoredHomey = new FakeHomey();
    restoredHomey.store = homey.store;
    const restored = new EnergyInsightsApp(restoredHomey);
    restoredHomey.app = restored;

    await restored.onInit();
    assert.ok(restored.markers.length > 0, 'markers survive a restart');
    await restored.onUninit();
  });

  it('destroys every capability instance when it unloads', async () => {
    await app.monitor.stop();
    for (const device of Object.values(devices)) {
      assert.equal(device.instances.length, 0, `${device.name} still has listeners attached`);
    }
  });

});
