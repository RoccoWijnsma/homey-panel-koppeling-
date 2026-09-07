'use strict';

const Homey = require('homey');

const { decodeAdvertisement, extractShadeRecord, isEncrypted, parseHomeKey } = require('../../lib/protocol');
const { getHomeyCapabilities, getTypeName } = require('../../lib/shade-types');
const { GatewayError, fetchHomeKey, normalizeHost } = require('../../lib/gateway');

/** Wait this long after boot before the first scan, so devices can register. */
const FIRST_SCAN_DELAY_MS = 5000;

/**
 * Let the radio settle after a command before scanning again. A scan occupies
 * the Bluetooth adapter, and a shade that is being scanned cannot be connected
 * to - so a burst of commands should not be interleaved with scans.
 */
const POST_COMMAND_QUIET_MS = 3000;

class ShadeDriver extends Homey.Driver {
  async onInit() {
    /**
     * Last advertisement seen per peripheral, whether or not a Homey device
     * exists for it. Pairing reads this too, so a shade already heard from is
     * offered immediately.
     * @type {Map<string, {uuid: string, address: string, localName: string, rssi: number, decoded: object, seenAt: number}>}
     */
    this.seen = new Map();

    /**
     * Peripherals already described in full in the log. A shade is worth a
     * detailed line the first time it is heard and never again - the scan runs
     * every minute, and repeating it would bury everything else.
     * @type {Set<string>}
     */
    this._described = new Set();

    /** Commands currently holding the Bluetooth adapter. */
    this._commandsInFlight = 0;
    this._scanTimer = null;
    this._scanning = false;
    this._stopped = false;

    this.shadeStoppedTrigger = this.homey.flow.getDeviceTriggerCard('shade_stopped');

    this._scheduleScan(FIRST_SCAN_DELAY_MS);
    this.log('shade driver ready');
  }

  async onUninit() {
    this._stopped = true;
    if (this._scanTimer) this.homey.clearTimeout(this._scanTimer);
    this._scanTimer = null;
  }

  // --- adapter arbitration ---------------------------------------------------

  /**
   * Claim the Bluetooth adapter for a command.
   *
   * Scans do not queue behind commands: a scan window is many seconds long,
   * and making a user's tap wait for one would be worse than skipping the
   * scan. So a command simply parks the scanner until it is done.
   */
  beginCommand() {
    this._commandsInFlight += 1;
  }

  /** Release the adapter, and hold the scanner off a little longer. */
  endCommand() {
    this._commandsInFlight = Math.max(0, this._commandsInFlight - 1);
    if (this._commandsInFlight === 0) this._scheduleScan(POST_COMMAND_QUIET_MS);
  }

  // --- scanning --------------------------------------------------------------

  /**
   * @param {number} delayMs
   */
  _scheduleScan(delayMs) {
    if (this._stopped) return;
    if (this._scanTimer) this.homey.clearTimeout(this._scanTimer);
    this._scanTimer = this.homey.setTimeout(() => {
      this._scanTimer = null;
      this._runScan().catch((err) => this.error('scan failed', err));
    }, delayMs);
  }

  async _runScan() {
    if (this._scanning || this._commandsInFlight > 0) {
      this._scheduleScan(POST_COMMAND_QUIET_MS);
      return;
    }

    this._scanning = true;
    try {
      this._dispatch(await this.scanForShades());
    } finally {
      // Rescheduling from the `finally` is what keeps the loop alive: a scan
      // that throws must not be the last one this app ever runs.
      this._scanning = false;
      this._scheduleScan(this.homey.app.getPollInterval() * 1000);
    }
  }

  /**
   * Scan once and decode every PowerView advertisement heard.
   *
   * Homey is asked for everything rather than for one service UUID: the filter
   * matches on advertised service UUIDs, and a shade that omits its service
   * from the advertisement would then never be heard. The manufacturer record
   * is the reliable test, and checking it locally costs nothing.
   *
   * @returns {Promise<Map<string, object>>} Keyed by peripheral UUID.
   */
  async scanForShades() {
    const results = new Map();

    let advertisements = [];
    try {
      advertisements = await this.homey.ble.discover();
    } catch (err) {
      this.error('Bluetooth scan failed', err);
      return results;
    }

    for (const advertisement of advertisements) {
      const record = extractShadeRecord(advertisement.manufacturerData);
      if (!record) continue;

      const decoded = decodeAdvertisement(record);
      if (!decoded) continue;

      const entry = {
        uuid: advertisement.uuid,
        address: advertisement.address || '',
        localName: advertisement.localName || '',
        rssi: advertisement.rssi,
        decoded,
        seenAt: Date.now(),
      };
      results.set(advertisement.uuid, entry);
      this.seen.set(advertisement.uuid, entry);
      this._describeOnce(entry);
    }

    this.log(
      results.size > 0
        ? `heard ${results.size} PowerView shade(s) among ${advertisements.length} Bluetooth device(s)`
        : `heard no PowerView shades among ${advertisements.length} Bluetooth device(s)`,
    );
    return results;
  }

  /**
   * Describe a shade in full, the first time it is heard.
   *
   * Everything needed to tell whether the app is reading a shade correctly is
   * in the advertisement, so one line per shade answers most of what a bug
   * report would otherwise have to ask for: which product it is, whether it
   * needs the home key, and how well Homey can hear it.
   *
   * @param {object} entry
   */
  _describeOnce(entry) {
    if (this._described.has(entry.uuid)) return;
    this._described.add(entry.uuid);

    const { decoded } = entry;
    const parts = [
      entry.localName || '(unnamed)',
      entry.address || entry.uuid,
      `${getTypeName(decoded.typeId)} (type ${decoded.typeId})`,
      isEncrypted(decoded)
        ? `encrypted, home ${decoded.homeId} - needs the home key`
        : 'not bound to a home, so no key needed',
      `position ${decoded.position1}%`,
      `tilt ${decoded.tilt}%`,
      `battery ${decoded.batteryLevel}%`,
      `rssi ${entry.rssi}`,
    ];
    if (decoded.clockLost) parts.push('clock lost');

    this.log(`shade: ${parts.join(' | ')}`);
  }

  /**
   * Hand each scan result to the device that owns it.
   *
   * @param {Map<string, object>} found
   */
  _dispatch(found) {
    for (const device of this.getDevices()) {
      const entry = found.get(device.getData().id);
      try {
        if (entry) {
          device.onAdvertisement(entry);
        } else {
          device.onNotHeard();
        }
      } catch (err) {
        // One device in a bad way must not cost every other device its update.
        this.error(`could not update ${device.getName()}`, err);
      }
    }
  }

  // --- pairing ---------------------------------------------------------------

  /**
   * @param {import('homey/lib/PairSession')} session
   */
  async onPair(session) {
    session.setHandler('get_home_key_state', async () => {
      const key = this.homey.app.getHomeKey();
      return { hasKey: Boolean(key) };
    });

    session.setHandler('save_home_key', async ({ homeKey }) => {
      const parsed = parseHomeKey(homeKey);
      if (!parsed) {
        throw new Error(this.homey.__('pair.errors.invalid_key'));
      }
      this.homey.settings.set('home_key', parsed.toString('hex'));
      return { hasKey: true };
    });

    session.setHandler('clear_home_key', async () => {
      this.homey.settings.unset('home_key');
      return { hasKey: false };
    });

    session.setHandler('fetch_home_key', async ({ gateway }) => {
      const host = normalizeHost(gateway);
      if (!host) throw new Error(this.homey.__('pair.errors.no_gateway'));

      try {
        const key = await fetchHomeKey(host, { log: (...args) => this.log(...args) });
        this.homey.settings.set('home_key', key.toString('hex'));
        return { hasKey: true };
      } catch (err) {
        this.error('gateway key fetch failed', err);
        throw new Error(
          err instanceof GatewayError
            ? this.homey.__('pair.errors.gateway_failed', { reason: err.message })
            : err.message,
        );
      }
    });

    session.setHandler('list_devices', async () => this.listDevices());
  }

  /**
   * @returns {Promise<object[]>} Everything heard, in Homey's pairing shape.
   */
  async listDevices() {
    const found = await this.scanForShades();
    const paired = new Set(this.getDevices().map((device) => device.getData().id));

    return [...found.values()]
      .filter((entry) => !paired.has(entry.uuid))
      .sort((a, b) => b.rssi - a.rssi)
      .map((entry) => this._toPairingDevice(entry));
  }

  /**
   * @param {object} entry
   * @returns {object}
   */
  _toPairingDevice(entry) {
    const { decoded } = entry;
    const typeName = getTypeName(decoded.typeId);

    return {
      // The local name distinguishes siblings of the same type; without one
      // the address tail does the same job.
      name: entry.localName || `${typeName} ${entry.address.slice(-5)}`,
      data: { id: entry.uuid },
      store: {
        address: entry.address,
        typeId: decoded.typeId,
        homeId: decoded.homeId,
        encrypted: isEncrypted(decoded),
      },
      settings: {
        velocity: 0,
        home_key: '',
        shade_type: `${typeName} (type ${decoded.typeId})`,
        ble_address: entry.address,
        firmware: '',
      },
      capabilities: getHomeyCapabilities(decoded.typeId),
      icon: '/drivers/shade/assets/icon.svg',
    };
  }
}

module.exports = ShadeDriver;
