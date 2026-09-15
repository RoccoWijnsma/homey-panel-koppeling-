'use strict';

const NumericRing = require('../lib/NumericRing');
const en = require('../locales/en.json');
const { format } = require('../lib/util');

/** Resolve a dotted key from the English locale file, the way Homey's __() does. */
function translate(key, values) {
  const template = key.split('.').reduce((node, part) => (node ? node[part] : undefined), en);
  return format(typeof template === 'string' ? template : key, values);
}

/**
 * Stand-in for DeviceMonitor that exposes the same surface the detector uses, so the detection
 * logic can be tested without a Homey instance or the homey-api package.
 */
class FakeMonitor {

  constructor(devices = []) {
    this.devices = new Map();
    for (const device of devices) this.add(device);
  }

  add({ id, name, role = 'consumer', power = 0, historyLength = 24 }) {
    const record = {
      id,
      name,
      role,
      power,
      powerCapability: 'measure_power',
      lastOnAt: 0,
      history: new NumericRing(historyLength),
    };
    record.history.fill(power);
    this.devices.set(id, record);
    return record;
  }

  setPower(id, power) {
    this.devices.get(id).power = power;
  }

  turnOn(id, power, at = Date.now()) {
    const record = this.devices.get(id);
    record.power = power;
    record.lastOnAt = at;
  }

  sample() {
    for (const record of this.devices.values()) record.history.push(record.power);
  }

  getDeltas(steps, minDelta = 25) {
    const deltas = [];
    for (const record of this.devices.values()) {
      const before = record.history.ago(steps);
      const delta = record.power - before;
      if (Math.abs(delta) < minDelta) continue;
      deltas.push({
        id: record.id,
        name: record.name,
        role: record.role,
        delta,
        power: record.power,
        before,
        startedFromStandby: before <= Math.max(10, Math.min(50, record.power * 0.05)),
      });
    }
    return deltas.sort((left, right) => right.delta - left.delta);
  }

  recentlyTurnedOn(windowMs) {
    const cutoff = Date.now() - windowMs;
    return [...this.devices.values()].filter((record) => record.lastOnAt >= cutoff);
  }

}

module.exports = { FakeMonitor, translate };
