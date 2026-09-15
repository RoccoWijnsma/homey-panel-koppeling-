'use strict';

/**
 * Stand-in for the `homey-api` package. Devices come from `globalThis.__TEST_DEVICES__`, which
 * lets a test build a household and then push capability values into the running app.
 */

class FakeCapabilityInstance {

  constructor(device, capabilityId, listener) {
    this.device = device;
    this.capabilityId = capabilityId;
    this.listener = listener;
    this.destroyed = false;
  }

  destroy() {
    this.destroyed = true;
    this.device.instances = this.device.instances.filter((instance) => instance !== this);
  }

}

class FakeDevice {

  constructor(properties) {
    Object.assign(this, {
      capabilities: [],
      capabilitiesObj: {},
      energy: {},
      class: 'other',
      driverUri: 'homey:app:com.example.test',
    }, properties);
    this.instances = [];
  }

  makeCapabilityInstance(capabilityId, listener) {
    const instance = new FakeCapabilityInstance(this, capabilityId, listener);
    this.instances.push(instance);
    return instance;
  }

  /** Push a capability value the way Homey would. */
  set(capabilityId, value) {
    this.capabilitiesObj[capabilityId] = { value };
    for (const instance of this.instances) {
      if (instance.capabilityId === capabilityId && !instance.destroyed) instance.listener(value);
    }
  }

}

class HomeyAPI {

  static async createAppAPI() {
    const registry = globalThis.__TEST_DEVICES__ || {};
    const listeners = new Map();

    return {
      devices: {
        async getDevices() {
          return registry;
        },
        async connect() {
          return true;
        },
        on(event, listener) {
          if (!listeners.has(event)) listeners.set(event, []);
          listeners.get(event).push(listener);
        },
        emit(event, ...args) {
          for (const listener of listeners.get(event) || []) listener(...args);
        },
      },
    };
  }

}

module.exports = { HomeyAPI, FakeDevice };
