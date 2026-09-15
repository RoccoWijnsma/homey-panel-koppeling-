'use strict';

const EventEmitter = require('events');
const { HomeyAPI } = require('homey-api');

const NumericRing = require('./NumericRing');
const { APP_ID, DEVICE_ROLE, LIMITS } = require('./constants');

/** Device classes that are worth annotating even when they do not report power themselves. */
const HEAVY_CLASSES = new Set([
  'airconditioning',
  'boiler',
  'coffeemachine',
  'dishwasher',
  'dryer',
  'evcharger',
  'fan',
  'heater',
  'heatpump',
  'kettle',
  'oven',
  'solarpanel',
  'vacuumcleaner',
  'washer',
]);

const HINTS = {
  solar: /\b(solar|pv|zonnepane|zonnepaneel|omvormer|inverter|growatt|enphase|solaredge)\b/i,
  battery: /\b(battery|batterij|accu|powerwall|thuisbatterij|sessy)\b/i,
  grid: /\b(p1|smart\s?meter|slimme\s?meter|grid|net\s?meter|netmeter|kwh\s?meter|energy\s?meter|aansluiting)\b/i,
};

/**
 * Watches `measure_power` and `onoff` across every device in Homey.
 *
 * The monitor holds one capability instance per tracked capability and pushes changes out as
 * events; it never polls. Capability instances are destroyed when a device disappears or the app
 * unloads, which is what keeps the app from leaking listeners on a long running Homey Pro.
 *
 * @fires DeviceMonitor#power  {{id,name,role,value,previous,delta}}
 * @fires DeviceMonitor#onoff  {{id,name,role,value,power,heavy}}
 * @fires DeviceMonitor#devices
 */
class DeviceMonitor extends EventEmitter {

  /**
   * @param {object} options
   * @param {import('homey').Homey} options.homey
   * @param {object} [options.roles] Persisted role overrides, keyed by device id.
   * @param {number} [options.historyLength] Per-device power history used for attribution.
   * @param {(...args:any[])=>void} [options.log]
   * @param {(...args:any[])=>void} [options.error]
   */
  constructor({ homey, roles = {}, historyLength = LIMITS.deviceHistory, log, error }) {
    super();
    this.homey = homey;
    this.roles = { ...roles };
    this.historyLength = historyLength;
    this.log = log || (() => {});
    this.error = error || (() => {});

    /** @type {Map<string, object>} Device records, keyed by device id. */
    this.devices = new Map();
    /** @type {Map<string, object>} Live capability instances, keyed by device id. */
    this._instances = new Map();
    this._api = null;
    this._started = false;
  }

  /** Connect to the Homey Web API and attach to every relevant device. */
  async start() {
    if (this._started) return;
    this._started = true;

    this._api = await HomeyAPI.createAppAPI({ homey: this.homey });

    // Realtime device events. Not fatal when unavailable: the app then still works with the
    // devices discovered at boot, it just does not notice new ones until the next restart.
    try {
      await this._api.devices.connect();
      this._api.devices.on('device.create', (device) => this._onDeviceCreate(device));
      this._api.devices.on('device.delete', (device) => this._onDeviceDelete(device));
      this._api.devices.on('device.update', (device) => this._onDeviceUpdate(device));
    } catch (error) {
      this.error('Realtime device events unavailable:', error.message);
    }

    const devices = await this._api.devices.getDevices();
    let attached = 0;
    for (const device of Object.values(devices)) {
      if (attached >= LIMITS.maxDevices) {
        this.error(`Device limit of ${LIMITS.maxDevices} reached, remaining devices are ignored`);
        break;
      }
      if (this._attach(device)) attached += 1;
    }

    this.log(`Monitoring ${this.devices.size} device(s)`);
    this.emit('devices');
  }

  /** Destroy every capability instance and drop all state. */
  async stop() {
    for (const id of [...this._instances.keys()]) this._detach(id);
    this.devices.clear();
    this._instances.clear();
    this._api = null;
    this._started = false;
  }

  /* ------------------------------------------------------------------ attaching */

  /** True for devices provided by this app itself: counting those would double count energy. */
  _isOwnDevice(device) {
    const uri = `${device.driverUri || ''}${device.driverId || ''}${device.ownerUri || ''}`;
    return uri.includes(APP_ID);
  }

  /** Pick the capability that carries the device's power reading. */
  _powerCapability(device) {
    const capabilities = Array.isArray(device.capabilities) ? device.capabilities : [];
    if (capabilities.includes('measure_power')) return 'measure_power';
    return capabilities.find((capability) => capability.startsWith('measure_power.')) || null;
  }

  /**
   * Track a device when it reports power, or when it is a heavy appliance whose on/off state is
   * worth annotating even without a power meter.
   *
   * @returns {boolean} Whether the device is now tracked.
   */
  _attach(device) {
    if (!device || !device.id || this.devices.has(device.id)) return false;
    if (this._isOwnDevice(device)) return false;

    const powerCapability = this._powerCapability(device);
    const capabilities = Array.isArray(device.capabilities) ? device.capabilities : [];
    const hasOnoff = capabilities.includes('onoff');
    const deviceClass = device.virtualClass || device.class || 'other';
    const heavy = HEAVY_CLASSES.has(deviceClass);

    if (!powerCapability && !(hasOnoff && heavy)) return false;

    const record = {
      id: device.id,
      name: device.name || device.id,
      zone: device.zoneName || null,
      class: deviceClass,
      heavy,
      powerCapability,
      hasOnoff,
      detectedRole: this._detectRole(device, deviceClass),
      power: 0,
      onoff: null,
      lastOnAt: 0,
      lastOffAt: 0,
      lastChangeAt: 0,
      history: new NumericRing(this.historyLength),
    };
    record.role = this.roles[device.id] && this.roles[device.id] !== DEVICE_ROLE.AUTO
      ? this.roles[device.id]
      : record.detectedRole;

    const instances = {};

    if (powerCapability) {
      const initial = Number(device.capabilitiesObj?.[powerCapability]?.value);
      record.power = Number.isFinite(initial) ? initial : 0;
      record.history.fill(record.power);
      try {
        instances.power = device.makeCapabilityInstance(powerCapability, (value) => {
          this._onPower(device.id, value);
        });
      } catch (error) {
        this.error(`Could not watch ${powerCapability} on ${record.name}:`, error.message);
      }
    }

    if (hasOnoff) {
      const initial = device.capabilitiesObj?.onoff?.value;
      record.onoff = typeof initial === 'boolean' ? initial : null;
      try {
        instances.onoff = device.makeCapabilityInstance('onoff', (value) => {
          this._onOnoff(device.id, value);
        });
      } catch (error) {
        this.error(`Could not watch onoff on ${record.name}:`, error.message);
      }
    }

    this.devices.set(device.id, record);
    this._instances.set(device.id, instances);
    return true;
  }

  _detach(id) {
    const instances = this._instances.get(id);
    if (instances) {
      for (const instance of Object.values(instances)) {
        try {
          instance?.destroy();
        } catch (error) {
          // A destroyed instance on an already removed device is not worth logging.
        }
      }
    }
    this._instances.delete(id);
    this.devices.delete(id);
  }

  /* ------------------------------------------------------------------ classification */

  /** Classify a device from its Homey metadata, before any user override is applied. */
  _detectRole(device, deviceClass) {
    if (deviceClass === 'solarpanel') return DEVICE_ROLE.SOLAR;
    if (deviceClass === 'battery' || device.energy?.homeBattery === true) return DEVICE_ROLE.BATTERY;

    const energy = device.energy || {};
    if (energy.cumulative === true
      || energy.cumulativeImportedCapability
      || energy.cumulativeExportedCapability) {
      return DEVICE_ROLE.GRID;
    }

    const haystack = `${device.name || ''} ${device.driverId || device.driverUri || ''}`;
    if (HINTS.solar.test(haystack)) return DEVICE_ROLE.SOLAR;
    if (HINTS.battery.test(haystack)) return DEVICE_ROLE.BATTERY;
    if (HINTS.grid.test(haystack)) return DEVICE_ROLE.GRID;

    return DEVICE_ROLE.CONSUMER;
  }

  /**
   * Override how a device is accounted for.
   *
   * @param {string} id Device id.
   * @param {string} role One of {@link DEVICE_ROLE}; AUTO restores auto detection.
   */
  setRole(id, role) {
    const record = this.devices.get(id);
    if (!Object.values(DEVICE_ROLE).includes(role)) throw new Error(`Unknown role: ${role}`);

    if (role === DEVICE_ROLE.AUTO) delete this.roles[id];
    else this.roles[id] = role;

    if (record) record.role = role === DEVICE_ROLE.AUTO ? record.detectedRole : role;
    this.emit('devices');
    return record ? record.role : role;
  }

  /* ------------------------------------------------------------------ events */

  _onPower(id, value) {
    const record = this.devices.get(id);
    if (!record) return;
    const power = Number(value);
    if (!Number.isFinite(power)) return;

    const previous = record.power;
    record.power = power;
    record.lastChangeAt = Date.now();

    this.emit('power', {
      id,
      name: record.name,
      role: record.role,
      value: power,
      previous,
      delta: power - previous,
    });
  }

  _onOnoff(id, value) {
    const record = this.devices.get(id);
    if (!record) return;
    if (typeof value !== 'boolean' || record.onoff === value) return;

    record.onoff = value;
    const now = Date.now();
    if (value) record.lastOnAt = now;
    else record.lastOffAt = now;

    this.emit('onoff', {
      id,
      name: record.name,
      role: record.role,
      value,
      power: record.power,
      heavy: record.heavy,
    });
  }

  _onDeviceCreate(device) {
    if (this.devices.size >= LIMITS.maxDevices) return;
    if (this._attach(device)) {
      this.log(`Device added to monitor: ${device.name}`);
      this.emit('devices');
    }
  }

  _onDeviceDelete(device) {
    if (!device?.id || !this.devices.has(device.id)) return;
    this._detach(device.id);
    this.emit('devices');
  }

  _onDeviceUpdate(device) {
    const record = this.devices.get(device?.id);
    if (!record) {
      // A device may gain measure_power later (for example after a firmware update).
      this._onDeviceCreate(device);
      return;
    }
    record.name = device.name || record.name;
    record.zone = device.zoneName || record.zone;
    const deviceClass = device.virtualClass || device.class || record.class;
    if (deviceClass !== record.class) {
      record.class = deviceClass;
      record.detectedRole = this._detectRole(device, deviceClass);
      if (!this.roles[record.id]) record.role = record.detectedRole;
    }
  }

  /* ------------------------------------------------------------------ sampling */

  /** Append the current power of every device to its history ring. Called once per sample. */
  sample() {
    for (const record of this.devices.values()) {
      record.history.push(record.power);
    }
  }

  /**
   * Power change per device over the last `steps` samples, biggest riser first.
   * This is the raw material the peak explanation is built from.
   *
   * @param {number} steps Number of samples to look back.
   * @param {number} [minDelta] Ignore devices that moved less than this many Watts.
   */
  getDeltas(steps, minDelta = 25) {
    const deltas = [];
    for (const record of this.devices.values()) {
      if (!record.powerCapability) continue;
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

  /** Devices that switched on within `windowMs`, used to phrase "X starting". */
  recentlyTurnedOn(windowMs) {
    const cutoff = Date.now() - windowMs;
    return [...this.devices.values()].filter((record) => record.lastOnAt >= cutoff);
  }

  get(id) {
    return this.devices.get(id) || null;
  }

  /** Plain, serialisable view of all tracked devices for the dashboard and Flow autocomplete. */
  snapshot() {
    return [...this.devices.values()]
      .map((record) => ({
        id: record.id,
        name: record.name,
        zone: record.zone,
        class: record.class,
        role: record.role,
        detectedRole: record.detectedRole,
        overridden: Boolean(this.roles[record.id]),
        power: Math.round(record.power),
        onoff: record.onoff,
        metered: Boolean(record.powerCapability),
      }))
      .sort((left, right) => Math.abs(right.power) - Math.abs(left.power) || left.name.localeCompare(right.name));
  }

}

module.exports = DeviceMonitor;
module.exports.HEAVY_CLASSES = HEAVY_CLASSES;
