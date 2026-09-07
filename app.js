'use strict';

const Homey = require('homey');

const { parseHomeKey } = require('./lib/protocol');

/** Settings key holding the home-wide AES key, as 32 hex characters. */
const SETTING_HOME_KEY = 'home_key';

/** Settings key holding how often to scan for advertisements, in seconds. */
const SETTING_POLL_INTERVAL = 'poll_interval';

const DEFAULT_POLL_INTERVAL = 60;
const MIN_POLL_INTERVAL = 15;

class PowerViewApp extends Homey.App {
  async onInit() {
    this.registerFlowCards();

    // One key covers every shade in a PowerView home, so it lives at app level
    // rather than being typed in once per device. Devices watch for changes so
    // a key pasted after pairing takes effect without re-adding anything.
    this.homey.settings.on('set', (key) => {
      if (key !== SETTING_HOME_KEY) return;
      this.log('home key changed');
      this.emit('home_key_changed');
    });

    this.log('PowerView BLE app ready');
  }

  /**
   * @returns {Buffer|null} The home-wide key, or null if none is set. A shade
   *   that has been added to a home in the PowerView app will not act on
   *   anything without it.
   */
  getHomeKey() {
    return parseHomeKey(this.homey.settings.get(SETTING_HOME_KEY));
  }

  /**
   * @returns {number} Seconds between advertisement scans. Floored, because a
   *   scan occupies the Bluetooth radio and a shade that is scanned constantly
   *   cannot be connected to.
   */
  getPollInterval() {
    const configured = Number(this.homey.settings.get(SETTING_POLL_INTERVAL));
    if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_POLL_INTERVAL;
    return Math.max(MIN_POLL_INTERVAL, Math.round(configured));
  }

  registerFlowCards() {
    this.homey.flow
      .getActionCard('identify')
      .registerRunListener(async ({ device }) => device.identify());

    this.homey.flow
      .getActionCard('activate_scene')
      .registerRunListener(async ({ device, scene }) => device.activateScene(scene));

    this.homey.flow
      .getActionCard('set_velocity')
      .registerRunListener(async ({ device, velocity }) => device.setVelocity(velocity));

    this.homey.flow
      .getConditionCard('is_moving')
      .registerRunListener(async ({ device }) => device.isMoving());
  }
}

module.exports = PowerViewApp;
module.exports.DEFAULT_POLL_INTERVAL = DEFAULT_POLL_INTERVAL;
module.exports.MIN_POLL_INTERVAL = MIN_POLL_INTERVAL;
module.exports.SETTING_HOME_KEY = SETTING_HOME_KEY;
module.exports.SETTING_POLL_INTERVAL = SETTING_POLL_INTERVAL;
