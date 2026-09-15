'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const EnergyAggregator = require('../lib/EnergyAggregator');
const EventDetector = require('../lib/EventDetector');
const { DEFAULTS, MARKER_TYPE } = require('../lib/constants');
const { FakeMonitor, translate } = require('./helpers');

/** Run a scenario sample by sample and collect everything the detector reported. */
function runScenario({ devices, steps, config = {} }) {
  const monitor = new FakeMonitor(devices);
  const aggregator = new EnergyAggregator({ solarStartThreshold: DEFAULTS.solarStartThreshold });
  const settings = { ...DEFAULTS, ...config };
  const detector = new EventDetector({ config: settings, monitor, translate });

  const events = [];
  let now = Date.now() - steps.length * settings.sampleInterval * 1000;

  for (const step of steps) {
    if (step) step(monitor, now);
    const totals = aggregator.aggregate(monitor.devices);
    const { solarPeak } = aggregator.update(totals, settings.sampleInterval, now);
    for (const event of detector.update(totals, { dtSeconds: settings.sampleInterval, now, solarPeak })) {
      events.push({ ...event, totals });
    }
    monitor.sample();
    now += settings.sampleInterval * 1000;
  }

  return { events, detector, aggregator, monitor };
}

const idle = (count) => Array.from({ length: count }, () => null);

describe('EventDetector', () => {

  it('explains a peak caused by a device starting while solar drops', () => {
    const { events } = runScenario({
      devices: [
        { id: 'base', name: 'Base load', power: 300 },
        { id: 'ac', name: 'Air Conditioning', power: 0 },
        { id: 'pv', name: 'Solar Panels', role: 'solar', power: 2000 },
      ],
      steps: [
        ...idle(40),
        (monitor, now) => {
          monitor.turnOn('ac', 3200, now);
          monitor.setPower('pv', 900);
        },
        ...idle(5),
      ],
    });

    const peak = events.find((event) => event.type === MARKER_TYPE.PEAK);
    assert.ok(peak, 'a peak should be detected');
    assert.match(peak.reason, /Air Conditioning starting/);
    assert.match(peak.reason, /solar yield dropped by 1\.1 kW/);
    assert.equal(peak.deviceName, 'Air Conditioning');
    assert.ok(peak.share > 50, `AC should own most of the rise, got ${peak.share}%`);
    assert.equal(peak.solarDelta, -1100);
  });

  it('names two devices when they ramp up together', () => {
    const { events } = runScenario({
      devices: [
        { id: 'base', name: 'Base load', power: 200 },
        { id: 'ev', name: 'EV Charger', power: 0 },
        { id: 'hp', name: 'Heat Pump', power: 100 },
      ],
      steps: [
        ...idle(40),
        (monitor, now) => {
          monitor.turnOn('ev', 2300, now);
          monitor.setPower('hp', 1600);
        },
        ...idle(5),
      ],
    });

    const peak = events.find((event) => event.type === MARKER_TYPE.PEAK);
    assert.ok(peak);
    assert.match(peak.reason, /EV Charger starting/);
    assert.match(peak.reason, /Heat Pump ramping up/);
    assert.equal(peak.contributors.length, 2);
  });

  it('honours the cooldown so one long load does not spam markers', () => {
    const { events } = runScenario({
      devices: [
        { id: 'base', name: 'Base load', power: 200 },
        { id: 'oven', name: 'Oven', power: 0 },
      ],
      steps: [
        ...idle(30),
        (monitor, now) => monitor.turnOn('oven', 3500, now),
        ...idle(10),
        (monitor) => monitor.setPower('oven', 0),
        ...idle(3),
        (monitor, now) => monitor.turnOn('oven', 3500, now),
        ...idle(10),
      ],
      config: { peakCooldown: 300 },
    });

    assert.equal(events.filter((event) => event.type === MARKER_TYPE.PEAK).length, 1);
  });

  it('reports solar milestones and feed-in transitions', () => {
    const { events } = runScenario({
      devices: [
        { id: 'base', name: 'Base load', power: 400 },
        { id: 'pv', name: 'Solar Panels', role: 'solar', power: 0 },
      ],
      steps: [
        ...idle(3),
        (monitor) => monitor.setPower('pv', 600),
        ...idle(3),
        (monitor) => monitor.setPower('pv', 2500),
        ...idle(3),
        (monitor) => monitor.setPower('pv', 100),
        ...idle(3),
        (monitor) => monitor.setPower('pv', 0),
        ...idle(3),
      ],
    });

    const types = events.map((event) => event.type);
    assert.ok(types.includes(MARKER_TYPE.SOLAR_START));
    assert.ok(types.includes(MARKER_TYPE.SOLAR_PEAK));
    assert.ok(types.includes(MARKER_TYPE.FEED_IN_START));
    assert.ok(types.includes(MARKER_TYPE.FEED_IN_END));
    assert.ok(types.includes(MARKER_TYPE.SOLAR_END));

    const solarPeak = events.find((event) => event.type === MARKER_TYPE.SOLAR_PEAK);
    assert.equal(solarPeak.watts, 2500);

    // Feed-in starts the moment 600 W of solar overtakes the 400 W base load, not later.
    const feedIn = events.find((event) => event.type === MARKER_TYPE.FEED_IN_START);
    assert.equal(feedIn.watts, 200);

    // Exactly one solar peak marker: the rising curve must not annotate every sample.
    const solarPeaks = events.filter((event) => event.type === MARKER_TYPE.SOLAR_PEAK);
    assert.equal(solarPeaks.length, 1);
  });

  it('does not fire below the threshold, however sharp the rise', () => {
    const { events } = runScenario({
      devices: [
        { id: 'base', name: 'Base load', power: 100 },
        { id: 'kettle', name: 'Kettle', power: 0 },
      ],
      steps: [...idle(30), (monitor, now) => monitor.turnOn('kettle', 1800, now), ...idle(5)],
      config: { peakThreshold: 3000 },
    });

    assert.equal(events.filter((event) => event.type === MARKER_TYPE.PEAK).length, 0);
  });

  it('blames unmetered load when a grid meter sees more than the devices do', () => {
    const { events } = runScenario({
      devices: [
        { id: 'meter', name: 'P1 Meter', role: 'grid', power: 300 },
        { id: 'plug', name: 'Desk Plug', power: 60 },
      ],
      steps: [...idle(40), (monitor) => monitor.setPower('meter', 4200), ...idle(5)],
    });

    const peak = events.find((event) => event.type === MARKER_TYPE.PEAK);
    assert.ok(peak);
    assert.equal(peak.contributors[0].name, 'Unmetered load');
    assert.match(peak.reason, /Unmetered load/);
  });

});
