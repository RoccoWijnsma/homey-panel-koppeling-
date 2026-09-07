'use strict';

const Homey = require('homey');

const { MIN_VELOCITY, SCENE_CLOSE, SCENE_OPEN } = require('../../lib/const');
const { isEncrypted, parseHomeKey } = require('../../lib/protocol');
const { getCapabilities, getHomeyCapabilities, getTypeName } = require('../../lib/shade-types');
const {
  buildLiftMove,
  buildSecondaryMove,
  buildTiltMove,
  readPosition,
  readSecondary,
  readState,
  readTilt,
  toPercent,
} = require('../../lib/position');
const { PowerViewShade } = require('../../lib/shade');

/**
 * Never mark a shade unavailable sooner than this, however short the scan
 * interval is. Bluetooth range is marginal at the edges of a house and a
 * single missed scan says nothing.
 */
const MIN_UNAVAILABLE_AFTER_MS = 15 * 60 * 1000;

/** Missed scans before a shade counts as out of reach. */
const MISSED_SCANS_ALLOWED = 5;

/**
 * A reading older than this is not trusted to answer "is it already there?",
 * so the command is sent rather than skipped.
 */
const FRESH_READING_MS = 5 * 60 * 1000;

class ShadeDevice extends Homey.Device {
  async onInit() {
    /** Last decoded advertisement, or null until one is heard. */
    this._decoded = null;
    this._lastSeen = 0;
    this._wasMoving = false;
    this._registered = new Set();
    this._deviceInfoRead = false;

    this._capabilities = getCapabilities(this.getStoreValue('typeId'));

    this._shade = new PowerViewShade({
      ble: this.homey.ble,
      peripheralUuid: this.getData().id,
      homeKey: this._resolveHomeKey(),
      encrypted: Boolean(this.getStoreValue('encrypted')),
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    });

    this._onHomeKeyChanged = () => {
      this._shade.homeKey = this._resolveHomeKey();
      this._refreshWarning();
    };
    this.homey.app.on('home_key_changed', this._onHomeKeyChanged);

    await this._syncCapabilities();
    this._refreshWarning();

    // A device that has never been heard from starts unavailable rather than
    // pretending to be ready; the first scan clears it.
    await this.setUnavailable(this.homey.__('device.searching')).catch(() => {});

    this.log(`${this.getName()} ready (${getTypeName(this.getStoreValue('typeId'))})`);
  }

  async onUninit() {
    this.homey.app.removeListener('home_key_changed', this._onHomeKeyChanged);
    await this._shade.disconnect();
  }

  async onDeleted() {
    this.homey.app.removeListener('home_key_changed', this._onHomeKeyChanged);
    this._shade.disconnect().catch(() => {});
  }

  /** @returns {boolean} Whether onInit has run far enough to take a scan result. */
  get _ready() {
    return Boolean(this._shade);
  }

  // --- capabilities ----------------------------------------------------------

  /**
   * Bring the device's capabilities in line with what its type supports, and
   * make sure every one of them has a listener.
   *
   * A shade paired before its type was known, or one whose type table entry has
   * since been corrected, would otherwise keep a control it cannot use - or
   * lack one it can.
   */
  async _syncCapabilities() {
    const wanted = getHomeyCapabilities(this.getStoreValue('typeId'));

    for (const capability of wanted) {
      if (this.hasCapability(capability)) continue;
      await this.addCapability(capability).catch((err) => this.error(`could not add ${capability}`, err));
    }
    for (const capability of this.getCapabilities()) {
      if (wanted.includes(capability)) continue;
      await this.removeCapability(capability).catch((err) => this.error(`could not remove ${capability}`, err));
    }

    this._registerListeners();
  }

  /**
   * Register a listener for every capability that does not have one yet.
   *
   * Registering twice throws, and capabilities can appear after a shade
   * reports a type it was not paired with, so the set of registrations is
   * tracked rather than assumed.
   */
  _registerListeners() {
    const listeners = {
      windowcoverings_set: (value) => this._setLift(value),
      powerview_secondary: (value) => this._setSecondary(value),
      windowcoverings_tilt_set: (value) => this._setTilt(value),
      windowcoverings_state: (value) => this._setState(value),
    };

    for (const [capability, listener] of Object.entries(listeners)) {
      if (this._registered.has(capability)) continue;
      if (!this.hasCapability(capability)) continue;
      this.registerCapabilityListener(capability, listener);
      this._registered.add(capability);
    }
  }

  /**
   * @param {number} value 0..1
   * @returns {Promise<void>}
   */
  async _setLift(value) {
    if (this._alreadyAt(readPosition, value)) return;
    await this._move(
      buildLiftMove(value, this._decoded, this._capabilities),
      `position to ${toPercent(value)}%`,
    );
  }

  /**
   * @param {number} value 0..1
   * @returns {Promise<void>}
   */
  async _setSecondary(value) {
    if (this._alreadyAt(readSecondary, value)) return;
    await this._move(
      buildSecondaryMove(value, this._decoded, this._capabilities),
      `top rail to ${toPercent(value)}%`,
    );
  }

  /**
   * @param {number} value 0..1
   * @returns {Promise<void>}
   */
  async _setTilt(value) {
    if (this._alreadyAt(readTilt, value)) return;
    await this._move(
      buildTiltMove(value, this._decoded, this._capabilities),
      `tilt to ${toPercent(value)}%`,
    );
  }

  /**
   * @param {'up'|'idle'|'down'} value
   * @returns {Promise<void>}
   */
  async _setState(value) {
    if (value === 'idle') {
      await this._withAdapter(() => this._shade.stop());
      return;
    }
    const target = value === 'up' ? 1 : 0;
    await this._move(
      buildLiftMove(target, this._decoded, this._capabilities),
      value === 'up' ? 'open' : 'close',
    );
  }

  /**
   * Whether the shade is already where a command would put it.
   *
   * Deliberately compares against the shade's own broadcast rather than the
   * capability value: Homey updates that optimistically around a listener, so
   * reading it back here would compare the target with itself and drop every
   * command. A reading too old to trust means the command goes out.
   *
   * @param {(decoded: object, caps: object) => number|null} read
   * @param {number} value 0..1
   * @returns {boolean}
   */
  _alreadyAt(read, value) {
    if (!this._decoded) return false;
    if (Date.now() - this._lastSeen > FRESH_READING_MS) return false;

    const current = read(this._decoded, this._capabilities);
    if (typeof current !== 'number') return false;
    return toPercent(current) === toPercent(value);
  }

  // --- sending ---------------------------------------------------------------

  /**
   * @param {object|null} move
   * @param {string} description
   */
  async _move(move, description) {
    if (!move) {
      // Some moves need a reading the shade has not broadcast yet: a tilt needs
      // the lift axis restated, a dual rail needs the other rail. Sending a
      // guess would move something the user did not ask to move.
      throw new Error(this.homey.__('device.no_reading'));
    }

    this.log(`${description}`);
    await this._withAdapter(() => this._shade.setPosition({ ...move, velocity: this._velocity() }));
  }

  /**
   * Run a command while holding the Bluetooth adapter, so the driver's scan
   * loop stays out of the way.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async _withAdapter(fn) {
    if (!this._shade.canControl) {
      throw new Error(this.homey.__('device.needs_home_key'));
    }

    this.driver.beginCommand();
    try {
      return await fn();
    } finally {
      this.driver.endCommand();
    }
  }

  /**
   * @returns {number} Velocity to send. The shade reads anything below its
   *   floor as "no velocity given" and then runs at full speed, so a setting in
   *   that band is raised rather than silently meaning its opposite.
   */
  _velocity() {
    const configured = Number(this.getSetting('velocity'));
    if (!Number.isFinite(configured) || configured <= 0) return 0;
    return Math.min(100, Math.max(MIN_VELOCITY, Math.round(configured)));
  }

  // --- flow ------------------------------------------------------------------

  /** @returns {Promise<void>} */
  async identify() {
    await this._withAdapter(() => this._shade.identify());
  }

  /**
   * @param {number} index
   * @returns {Promise<void>}
   */
  async activateScene(index) {
    await this._withAdapter(() => this._shade.activateScene(index));
  }

  /**
   * @param {number} velocity
   * @returns {Promise<void>}
   */
  async setVelocity(velocity) {
    await this.setSettings({ velocity: Math.max(0, Math.min(100, Math.round(velocity))) });
  }

  /** @returns {boolean} */
  isMoving() {
    return Boolean(this._decoded && (this._decoded.isOpening || this._decoded.isClosing));
  }

  /** @returns {Promise<void>} Run the open scene the shade stores itself. */
  async open() {
    await this._withAdapter(() => this._shade.activateScene(SCENE_OPEN));
  }

  /** @returns {Promise<void>} Run the close scene the shade stores itself. */
  async close() {
    await this._withAdapter(() => this._shade.activateScene(SCENE_CLOSE));
  }

  // --- advertisements --------------------------------------------------------

  /**
   * Take a scan result for this shade.
   *
   * This is the only source of position, tilt and battery: the shade broadcasts
   * them rather than answering questions, so everything the user sees between
   * commands arrives here.
   *
   * @param {{decoded: object, address: string, seenAt: number}} entry
   */
  onAdvertisement(entry) {
    if (!this._ready) return;

    const { decoded } = entry;
    this._decoded = decoded;
    this._lastSeen = entry.seenAt;

    // The shade says whether it is bound to a home, and so whether it will
    // ignore plaintext. Trusting the advertisement over the stored value means
    // a shade added to - or removed from - a home in the PowerView app is
    // picked up without re-pairing.
    const encrypted = isEncrypted(decoded);
    if (encrypted !== this._shade.encrypted) {
      this._shade.encrypted = encrypted;
      this.setStoreValue('encrypted', encrypted).catch(() => {});
      this._refreshWarning();
    }
    this._shade.clockLost = decoded.clockLost;

    if (decoded.typeId !== this.getStoreValue('typeId')) {
      this._adoptType(decoded.typeId);
    }

    this._publish(decoded);
    this.setAvailable().catch(() => {});
    this._readDeviceInfoOnce();
  }

  /**
   * @param {number} typeId
   */
  _adoptType(typeId) {
    this.setStoreValue('typeId', typeId)
      .then(() => {
        this._capabilities = getCapabilities(typeId);
        return this._syncCapabilities();
      })
      .then(() => this.setSettings({ shade_type: `${getTypeName(typeId)} (type ${typeId})` }))
      .catch((err) => this.error('could not adopt the shade type', err));
  }

  /**
   * @param {object} decoded
   */
  _publish(decoded) {
    const values = {
      windowcoverings_set: readPosition(decoded, this._capabilities),
      powerview_secondary: readSecondary(decoded, this._capabilities),
      windowcoverings_tilt_set: readTilt(decoded, this._capabilities),
      windowcoverings_state: readState(decoded),
      measure_battery: decoded.batteryLevel,
    };

    for (const [capability, value] of Object.entries(values)) {
      if (value === null || value === undefined) continue;
      if (!this.hasCapability(capability)) continue;
      this.setCapabilityValue(capability, value).catch((err) => this.error(`could not set ${capability}`, err));
    }

    const moving = decoded.isOpening || decoded.isClosing;
    if (this._wasMoving && !moving) {
      this.driver.shadeStoppedTrigger.trigger(this).catch((err) => this.error('trigger failed', err));
    }
    this._wasMoving = moving;
  }

  /** Called for every scan this shade was not heard in. */
  onNotHeard() {
    if (!this._ready || !this._lastSeen) return;

    const interval = this.homey.app.getPollInterval() * 1000;
    const limit = Math.max(interval * MISSED_SCANS_ALLOWED, MIN_UNAVAILABLE_AFTER_MS);
    if (Date.now() - this._lastSeen < limit) return;

    this.setUnavailable(this.homey.__('device.out_of_range')).catch(() => {});
  }

  /**
   * Read the shade's firmware version, once, the first time it is heard.
   *
   * Worth knowing - behaviour differs between firmwares, and a bug report
   * without it is hard to act on - but it costs a connection, so it is done
   * once per app run and never retried on failure.
   */
  _readDeviceInfoOnce() {
    if (this._deviceInfoRead) return;
    this._deviceInfoRead = true;

    if (this.getSetting('firmware')) return;
    if (!this._shade.canControl) return;

    this._withAdapter(() => this._shade.readDeviceInfo())
      .then((info) => {
        const firmware = [info.firmwareRevision, info.hardwareRevision]
          .filter(Boolean)
          .join(' / ');
        if (!firmware) return null;
        return this.setSettings({ firmware });
      })
      .catch((err) => this.log(`could not read device information: ${err.message}`));
  }

  // --- settings --------------------------------------------------------------

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('home_key')) {
      this._shade.homeKey = this._resolveHomeKey();
      this._refreshWarning();
    }
  }

  /**
   * @returns {Buffer|null} The per-device key if one is set, otherwise the
   *   home-wide one. One key covers a whole PowerView home, so the override
   *   only matters to someone whose Homey reaches shades from two of them.
   */
  _resolveHomeKey() {
    return parseHomeKey(this.getSetting('home_key')) || this.homey.app.getHomeKey();
  }

  /**
   * Say, on the device tile itself, when the shade will not take commands.
   *
   * An encrypted shade without a key accepts writes and silently ignores them,
   * which is otherwise indistinguishable from a shade that is stuck.
   */
  _refreshWarning() {
    if (this._shade.canControl) {
      this.unsetWarning().catch(() => {});
      return;
    }
    this.setWarning(this.homey.__('device.needs_home_key')).catch(() => {});
  }
}

module.exports = ShadeDevice;
