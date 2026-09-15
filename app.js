'use strict';

const EventEmitter = require('events');
const Homey = require('homey');

const DeviceMonitor = require('./lib/DeviceMonitor');
const EnergyAggregator = require('./lib/EnergyAggregator');
const EventDetector = require('./lib/EventDetector');
const MarkerStore = require('./lib/MarkerStore');
const TimelineStore = require('./lib/TimelineStore');
const {
  DEFAULTS,
  DEVICE_ROLE,
  LIMITS,
  MARKER_TYPE,
  SETTINGS_KEY,
} = require('./lib/constants');
const { clamp, format, formatWatts, round } = require('./lib/util');

/** How often the in-memory timeline is written to Homey's settings store. */
const PERSIST_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Homey Energy Insights.
 *
 * Samples every `measure_power` capability in the home on a fixed cadence, keeps the result in a
 * bounded multi resolution timeline, annotates it with the events that explain its shape, and
 * serves all of that to the dashboard, the Flow engine and the mirror device.
 */
class EnergyInsightsApp extends Homey.App {

  async onInit() {
    /** Internal bus the mirror device subscribes to, so devices never poll the app. */
    this.events = new EventEmitter();
    this.events.setMaxListeners(32);

    this.config = this._loadConfig();
    this.roles = this.homey.settings.get(SETTINGS_KEY.ROLES) || {};

    this.timeline = new TimelineStore();
    this.markers = new MarkerStore({
      capacity: this.config.markerCapacity,
      retentionMs: this.config.markerRetentionHours * 3600 * 1000,
    });
    this.aggregator = new EnergyAggregator({ solarStartThreshold: this.config.solarStartThreshold });

    this.monitor = new DeviceMonitor({
      homey: this.homey,
      roles: this.roles,
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    });

    this.detector = new EventDetector({
      config: this.config,
      monitor: this.monitor,
      translate: (key, values) => this.translate(key, values),
    });

    /** Last aggregated sample, served by /state and the widget. */
    this.totals = this.aggregator.aggregate(new Map());
    this._lastSampleAt = Date.now();
    this._lastBroadcastAt = 0;
    this._lastPeak = null;

    this._restore();
    this._registerFlowCards();

    this.monitor.on('power', (event) => this._onDevicePower(event));
    this.monitor.on('onoff', (event) => this._onDeviceOnoff(event));
    this.monitor.on('devices', () => this.broadcast('devices', { count: this.monitor.devices.size }));

    this.homey.settings.on('set', (key) => this._onSettingsChanged(key));
    this.homey.on('unload', () => this._persist());
    this.homey.on('memwarn', (data) => this._onMemoryWarning(data));

    // Device discovery talks to the Homey Web API; a failure there must not take the app down.
    this.monitor.start()
      .then(() => this._tick())
      .catch((error) => this.error('Could not start device monitoring:', error));

    this._startSampling();
    this._persistTimer = this.homey.setInterval(() => this._persist(), PERSIST_INTERVAL_MS);

    this.log(`Homey Energy Insights ready (sampling every ${this.config.sampleInterval}s)`);
  }

  async onUninit() {
    this._stopSampling();
    if (this._persistTimer) this.homey.clearInterval(this._persistTimer);
    this._persist();
    await this.monitor.stop();
  }

  /* ================================================================== configuration */

  /** Merge the stored settings over the defaults and clamp everything into a safe range. */
  _loadConfig() {
    const stored = this.homey.settings.get(SETTINGS_KEY.CONFIG) || {};
    const config = { ...DEFAULTS, ...stored };

    config.sampleInterval = clamp(
      config.sampleInterval, LIMITS.minSampleInterval, LIMITS.maxSampleInterval, DEFAULTS.sampleInterval,
    );
    config.peakThreshold = clamp(config.peakThreshold, 50, 100000, DEFAULTS.peakThreshold);
    config.peakDelta = clamp(config.peakDelta, 0, 100000, DEFAULTS.peakDelta);
    config.peakCooldown = clamp(config.peakCooldown, 10, 3600, DEFAULTS.peakCooldown);
    config.attributionWindow = clamp(config.attributionWindow, 10, 600, DEFAULTS.attributionWindow);
    config.minMarkerPower = clamp(config.minMarkerPower, 0, 100000, DEFAULTS.minMarkerPower);
    config.markerRetentionHours = clamp(config.markerRetentionHours, 1, 168, DEFAULTS.markerRetentionHours);
    config.markerCapacity = clamp(config.markerCapacity, 10, LIMITS.maxMarkers, DEFAULTS.markerCapacity);
    config.solarStartThreshold = clamp(config.solarStartThreshold, 1, 10000, DEFAULTS.solarStartThreshold);
    config.peakSource = config.peakSource === 'net' ? 'net' : 'consumption';
    config.trackDeviceSwitches = config.trackDeviceSwitches !== false;
    config.trackSolarEvents = config.trackSolarEvents !== false;
    config.debug = config.debug === true;

    return config;
  }

  /**
   * Apply a configuration change coming from the dashboard or from a Flow action.
   *
   * @param {object} patch Partial configuration.
   * @returns {object} The configuration as it is now.
   */
  setConfig(patch = {}) {
    const previousInterval = this.config.sampleInterval;
    const previousSource = this.config.peakSource;

    this.homey.settings.set(SETTINGS_KEY.CONFIG, { ...this.config, ...patch });
    this.config = this._loadConfig();

    // The detector holds a reference to this.config, so keep mutating the same object shape.
    this.detector.config = this.config;
    this.aggregator.solarStartThreshold = this.config.solarStartThreshold;
    this.markers.configure({
      capacity: this.config.markerCapacity,
      retentionMs: this.config.markerRetentionHours * 3600 * 1000,
    });

    if (this.config.peakSource !== previousSource) this.detector.reset();
    if (this.config.sampleInterval !== previousInterval) this._startSampling();

    this.broadcast('config', this.config);
    return this.config;
  }

  _onSettingsChanged(key) {
    // Settings can also be written outside of the API (for example by a restore), so re-read.
    if (key === SETTINGS_KEY.CONFIG) this.config = this._loadConfig();
    if (key === SETTINGS_KEY.ROLES) this.roles = this.homey.settings.get(SETTINGS_KEY.ROLES) || {};
  }

  /* ================================================================== sampling loop */

  _startSampling() {
    this._stopSampling();
    this._sampleTimer = this.homey.setInterval(() => this._tick(), this.config.sampleInterval * 1000);
  }

  _stopSampling() {
    if (this._sampleTimer) {
      this.homey.clearInterval(this._sampleTimer);
      this._sampleTimer = null;
    }
  }

  /**
   * One pass of the sampling loop: read every device, store a sample, detect events.
   * Everything in here is bounded work - no allocation grows with uptime.
   */
  _tick() {
    const now = Date.now();
    const dtSeconds = Math.max(0.5, (now - this._lastSampleAt) / 1000);
    this._lastSampleAt = now;

    try {
      this.monitor.sample();
      const totals = this.aggregator.aggregate(this.monitor.devices);
      const { solarPeak } = this.aggregator.update(totals, dtSeconds, now);

      this.timeline.ingest({
        t: now,
        consumption: totals.consumption,
        solar: totals.solar,
        net: totals.net,
      });

      const events = this.detector.update(totals, { dtSeconds, now, solarPeak });
      this.totals = totals;

      for (const event of events) this._handleEvent(event, totals);

      this.events.emit('state', this.getState());
      this._broadcastState(now);
    } catch (error) {
      this.error('Sampling failed:', error);
    }
  }

  /** Turn a detector event into a marker plus the matching Flow trigger. */
  _handleEvent(event, totals) {
    switch (event.type) {
      case MARKER_TYPE.PEAK: {
        this._lastPeak = event;
        const marker = this.addMarker({
          t: event.t,
          type: MARKER_TYPE.PEAK,
          label: this.translate('marker.peak', { watts: formatWatts(event.watts) }),
          watts: event.watts,
          delta: event.delta,
          reason: event.reason,
          deviceId: event.deviceId,
          deviceName: event.deviceName,
          contributors: event.contributors,
        });

        const tokens = {
          watts: round(event.watts),
          delta: round(event.delta),
          device: event.deviceName || this.translate('reason.unattributed'),
          reason: event.reason,
          solar: round(totals.solar),
          net: round(totals.net),
        };
        this._trigger('power_peak_above', tokens, { watts: event.watts });

        if (event.deviceId) {
          this._trigger('device_caused_spike', {
            device: event.deviceName,
            delta: round(event.contributors[0]?.delta || event.delta),
            watts: round(event.watts),
            share: round(event.share),
            reason: event.reason,
          }, { deviceId: event.deviceId });
        }

        this.events.emit('peak', { ...event, marker });
        break;
      }

      case MARKER_TYPE.SOLAR_PEAK:
        this.addMarker({
          t: event.t,
          type: event.type,
          label: this.translate('marker.solarPeak', { watts: formatWatts(event.watts) }),
          watts: event.watts,
        });
        this._trigger('solar_peak_reached', {
          watts: round(event.watts),
          previous: round(event.previous || 0),
        });
        break;

      case MARKER_TYPE.FEED_IN_START:
        this.addMarker({
          t: event.t,
          type: event.type,
          label: this.translate('marker.feedInStart'),
          watts: event.watts,
        });
        this._trigger('feed_in_started', {
          watts: round(event.watts),
          solar: round(event.solar),
          consumption: round(event.consumption),
        });
        break;

      case MARKER_TYPE.FEED_IN_END:
      case MARKER_TYPE.SOLAR_START:
      case MARKER_TYPE.SOLAR_END: {
        const labels = {
          [MARKER_TYPE.FEED_IN_END]: 'marker.feedInEnd',
          [MARKER_TYPE.SOLAR_START]: 'marker.solarStart',
          [MARKER_TYPE.SOLAR_END]: 'marker.solarEnd',
        };
        this.addMarker({
          t: event.t,
          type: event.type,
          label: this.translate(labels[event.type]),
          watts: event.watts,
        });
        break;
      }

      default:
        break;
    }
  }

  /* ================================================================== device events */

  _onDevicePower() {
    // Power changes are folded into the next sample; storing them individually would turn a
    // chatty energy meter into thousands of writes per minute.
  }

  /** A device switching on or off is the most literal answer to "what changed?". */
  _onDeviceOnoff(event) {
    if (!this.config.trackDeviceSwitches) return;

    const record = this.monitor.get(event.id);
    const significant = record?.heavy
      || Math.abs(event.power) >= this.config.minMarkerPower
      || (event.value === true && record?.role === DEVICE_ROLE.SOLAR);
    if (!significant) return;

    this.addMarker({
      type: event.value ? MARKER_TYPE.DEVICE_ON : MARKER_TYPE.DEVICE_OFF,
      label: this.translate(event.value ? 'marker.deviceOn' : 'marker.deviceOff', { device: event.name }),
      deviceId: event.id,
      deviceName: event.name,
      watts: this.totals.consumption,
      delta: event.value ? event.power : -event.power,
    });
  }

  /** Homey warns before it starts killing apps; shed the finest tier and half the markers. */
  _onMemoryWarning(data) {
    this.error(`Memory warning (${data?.count || '?'}), trimming buffers`);
    this.timeline.liveTier.buffer.clear();
    this.markers.configure({ capacity: Math.max(50, Math.floor(this.markers.capacity / 2)) });
  }

  /* ================================================================== markers */

  /**
   * Add a marker and tell everyone about it.
   *
   * @param {object} marker See {@link MarkerStore#add}.
   * @returns {object|null} The stored marker, or null when it was deduplicated.
   */
  addMarker(marker) {
    const stored = this.markers.add(marker);
    if (!stored) return null;

    this.broadcast('marker', stored);
    this._trigger('marker_added', {
      label: stored.label,
      type: stored.type,
      watts: round(stored.watts || this.totals.consumption || 0),
    });
    return stored;
  }

  /* ================================================================== flow */

  _registerFlowCards() {
    const flow = this.homey.flow;

    flow.getTriggerCard('power_peak_above')
      .registerRunListener((args, state) => state.watts >= args.watts);

    flow.getTriggerCard('device_caused_spike')
      .registerRunListener((args, state) => args.device?.id === '__any__' || args.device?.id === state.deviceId)
      .registerArgumentAutocompleteListener('device', (query) => this._deviceAutocomplete(query));

    flow.getConditionCard('usage_higher_than_solar')
      .registerRunListener((args) => this.totals.consumption > this.totals.solar + (args.margin || 0));

    flow.getConditionCard('is_feeding_in')
      .registerRunListener(() => this.totals.net < -this.config.solarStartThreshold);

    flow.getConditionCard('series_above')
      .registerRunListener((args) => {
        const value = this.totals[args.series === 'net' ? 'net' : args.series] || 0;
        return value > args.watts;
      });

    flow.getActionCard('add_marker')
      .registerRunListener(async (args) => {
        const marker = this.addMarker({
          type: MARKER_TYPE.CUSTOM,
          label: this.translate('marker.custom', { label: args.label }),
          color: args.color || 'grey',
          watts: this.totals.consumption,
        });
        return { watts: round(marker?.watts ?? this.totals.consumption) };
      });

    flow.getActionCard('set_peak_threshold')
      .registerRunListener(async (args) => {
        this.setConfig({ peakThreshold: args.watts });
        return true;
      });
  }

  /** Fire a trigger card without letting a Flow error bubble into the sampling loop. */
  _trigger(cardId, tokens, state = {}) {
    try {
      this.homey.flow.getTriggerCard(cardId)
        .trigger(tokens, state)
        .catch((error) => this.error(`Trigger ${cardId} failed:`, error.message));
    } catch (error) {
      this.error(`Trigger ${cardId} unavailable:`, error.message);
    }
  }

  /** Autocomplete for the device spike trigger, including an "any device" catch-all. */
  _deviceAutocomplete(query = '') {
    const needle = String(query).toLowerCase();
    const any = { id: '__any__', name: this.homey.__('settings.devices.auto') || 'Any device' };

    const devices = this.monitor.snapshot()
      .filter((device) => device.metered)
      .filter((device) => !needle || device.name.toLowerCase().includes(needle))
      .slice(0, 50)
      .map((device) => ({
        id: device.id,
        name: device.name,
        description: device.zone || undefined,
      }));

    return needle ? devices : [any, ...devices];
  }

  /* ================================================================== public API */

  /** Live snapshot for the dashboard, the widget and the mirror device. */
  getState() {
    return {
      t: this._lastSampleAt,
      ...this.totals,
      today: this.aggregator.today,
      peak: this._lastPeak
        ? {
          t: this._lastPeak.t,
          watts: round(this._lastPeak.watts),
          reason: this._lastPeak.reason,
          device: this._lastPeak.deviceName,
        }
        : null,
      inPeak: this.detector.inPeak,
      baseline: round(this.detector.baseline || 0),
      threshold: this.config.peakThreshold,
      devices: this.monitor.devices.size,
      sampleInterval: this.config.sampleInterval,
    };
  }

  /**
   * A window of the timeline plus the markers inside it.
   *
   * @param {object} [query]
   * @param {number} [query.from] Defaults to 15 minutes ago.
   * @param {number} [query.to] Defaults to now.
   * @param {number} [query.points] Maximum number of points.
   */
  getTimeline({ from, to, points } = {}) {
    const end = Number(to) || Date.now();
    const start = Number(from) || end - 15 * 60 * 1000;
    const maxPoints = clamp(points, 10, LIMITS.maxQueryPoints, 600);

    const result = this.timeline.query({ from: start, to: end, maxPoints });
    return {
      ...result,
      now: Date.now(),
      oldest: this.timeline.oldest,
      markers: this.markers.list({ from: start, to: end }),
      state: this.getState(),
    };
  }

  getMarkers(query = {}) {
    return this.markers.list({
      from: Number(query.from) || 0,
      to: Number(query.to) || Date.now(),
      limit: clamp(query.limit, 1, LIMITS.maxMarkers, 500),
      types: typeof query.types === 'string' ? query.types.split(',') : null,
    });
  }

  getDevices() {
    return {
      devices: this.monitor.snapshot(),
      roles: Object.values(DEVICE_ROLE),
      totals: this.totals,
    };
  }

  /** Override how a device counts towards the energy balance. */
  setDeviceRole(id, role) {
    const applied = this.monitor.setRole(id, role);
    this.roles = { ...this.monitor.roles };
    this.homey.settings.set(SETTINGS_KEY.ROLES, this.roles);
    return { id, role: applied };
  }

  /** Numbers behind the "is this app behaving itself" question. */
  getDiagnostics() {
    const memory = typeof process !== 'undefined' && process.memoryUsage ? process.memoryUsage() : {};
    return {
      uptime: Math.round(process.uptime?.() || 0),
      devices: this.monitor.devices.size,
      markers: this.markers.length,
      timelineBytes: this.timeline.bytes,
      tiers: this.timeline.tiers.map((tier) => ({
        id: tier.id,
        interval: tier.interval,
        samples: tier.buffer.length,
        capacity: tier.buffer.capacity,
      })),
      heapUsed: memory.heapUsed || null,
      config: this.config,
    };
  }

  /* ================================================================== plumbing */

  /** Localise a key and fill its {placeholders}. */
  translate(key, values) {
    let template = key;
    try {
      template = this.homey.__(key);
    } catch (error) {
      // Falls through to the raw key, which is still readable.
    }
    return format(typeof template === 'string' ? template : key, values);
  }

  /** Push an event to every open dashboard. Realtime is best effort by design. */
  broadcast(event, data) {
    try {
      this.homey.api.realtime(event, data);
    } catch (error) {
      if (this.config.debug) this.error(`Broadcast ${event} failed:`, error.message);
    }
  }

  _broadcastState(now) {
    if (now - this._lastBroadcastAt < LIMITS.broadcastInterval) return;
    this._lastBroadcastAt = now;
    this.broadcast('state', this.getState());
  }

  /* ================================================================== persistence */

  _restore() {
    try {
      const snapshot = this.homey.settings.get(SETTINGS_KEY.SNAPSHOT);
      if (!snapshot) return;
      this.timeline.fromJSON(snapshot.timeline);
      this.markers.fromJSON(snapshot.markers);
      this.aggregator.fromJSON(snapshot.aggregator);
      this.log(`Restored ${this.markers.length} marker(s) and ${this.timeline.oldest ? 'history' : 'no history'}`);
    } catch (error) {
      this.error('Could not restore the previous session:', error.message);
    }
  }

  /**
   * Write a compact snapshot to Homey's settings store.
   * Settings are not a database, so the payload is size checked and markers are shed first.
   */
  _persist() {
    try {
      const snapshot = {
        timeline: this.timeline.toJSON(),
        markers: this.markers.toJSON(),
        aggregator: this.aggregator.toJSON(),
      };

      let payload = JSON.stringify(snapshot);
      if (payload.length > LIMITS.maxPersistBytes) {
        snapshot.markers.markers = snapshot.markers.markers.slice(-100);
        payload = JSON.stringify(snapshot);
      }
      if (payload.length > LIMITS.maxPersistBytes) {
        this.error(`Snapshot of ${payload.length} bytes is too large, keeping markers only`);
        this.homey.settings.set(SETTINGS_KEY.SNAPSHOT, { markers: snapshot.markers });
        return;
      }

      this.homey.settings.set(SETTINGS_KEY.SNAPSHOT, snapshot);
    } catch (error) {
      this.error('Could not persist the timeline:', error.message);
    }
  }

}

module.exports = EnergyInsightsApp;
