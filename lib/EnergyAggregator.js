'use strict';

const { DEVICE_ROLE } = require('./constants');
const { round, startOfDay } = require('./util');

/**
 * Turns the live device readings into the three series that make up the timeline, and keeps the
 * running totals for "today".
 *
 * Two balance models are used, depending on what the home has:
 *
 * - **With a grid meter** (P1 / smart meter) the meter is authoritative for net power, and
 *   household usage is derived from it: `usage = net + solar + battery discharge - battery charge`.
 *   Anything the metered devices do not explain is reported as `unmetered`, which the peak
 *   explanation can then name instead of blaming the wrong device.
 * - **Without a grid meter** usage is the sum of the metered consumers and net power is derived:
 *   `net = usage - solar - battery discharge`.
 */
class EnergyAggregator {

  /**
   * @param {object} [options]
   * @param {number} [options.solarStartThreshold] Watts above which solar counts as producing.
   */
  constructor({ solarStartThreshold = 50 } = {}) {
    this.solarStartThreshold = solarStartThreshold;
    this.reset();
  }

  reset() {
    this.day = startOfDay();
    this.stats = {
      peakToday: 0,
      peakTodayAt: null,
      solarPeakToday: 0,
      solarPeakTodayAt: null,
      consumedKwh: 0,
      producedKwh: 0,
      importedKwh: 0,
      exportedKwh: 0,
    };
  }

  /**
   * Sum the current readings of all tracked devices.
   *
   * @param {Map<string, object>} devices Device records from {@link DeviceMonitor}.
   * @returns {object} Totals in Watt.
   */
  aggregate(devices) {
    let consumers = 0;
    let solar = 0;
    let grid = 0;
    let batteryCharge = 0;
    let batteryDischarge = 0;
    let gridMeters = 0;
    let solarDevices = 0;
    let metered = 0;

    for (const record of devices.values()) {
      if (!record.powerCapability) continue;
      const power = Number.isFinite(record.power) ? record.power : 0;
      metered += 1;

      switch (record.role) {
        case DEVICE_ROLE.SOLAR:
          solarDevices += 1;
          // Most inverters report production as a positive number; a few report it negative.
          // Small negative values are night-time standby draw and are ignored on purpose.
          if (power >= 0) solar += power;
          else if (power < -this.solarStartThreshold) solar += -power;
          break;
        case DEVICE_ROLE.GRID:
          gridMeters += 1;
          grid += power;
          break;
        case DEVICE_ROLE.BATTERY:
          if (power >= 0) batteryCharge += power;
          else batteryDischarge += -power;
          break;
        case DEVICE_ROLE.IGNORE:
          break;
        default:
          if (power > 0) consumers += power;
          break;
      }
    }

    const hasGridMeter = gridMeters > 0;
    let net;
    let consumption;
    let unmetered = 0;

    if (hasGridMeter) {
      net = grid;
      consumption = Math.max(0, net + solar + batteryDischarge - batteryCharge);
      unmetered = Math.max(0, consumption - consumers - batteryCharge);
    } else {
      consumption = consumers + batteryCharge;
      net = consumption - solar - batteryDischarge;
    }

    const supplied = solar + batteryDischarge;
    const covered = Math.min(consumption, supplied);

    return {
      consumption: round(consumption),
      solar: round(solar),
      net: round(net),
      gridImport: round(Math.max(0, net)),
      gridExport: round(Math.max(0, -net)),
      batteryCharge: round(batteryCharge),
      batteryDischarge: round(batteryDischarge),
      meteredConsumers: round(consumers),
      unmetered: round(unmetered),
      selfSufficiency: consumption > 0 ? round((covered / consumption) * 100) : 100,
      hasGridMeter,
      hasSolar: solarDevices > 0,
      meteredDevices: metered,
    };
  }

  /**
   * Fold a sample into the daily statistics.
   *
   * @param {object} totals Output of {@link EnergyAggregator#aggregate}.
   * @param {number} dtSeconds Seconds since the previous sample.
   * @param {number} [now]
   * @returns {{solarPeak:{watts:number,previous:number}|null}} Milestones reached by this sample.
   */
  update(totals, dtSeconds, now = Date.now()) {
    if (startOfDay(now) !== this.day) this.reset();

    const hours = Math.max(0, dtSeconds) / 3600;
    this.stats.consumedKwh += (totals.consumption * hours) / 1000;
    this.stats.producedKwh += (totals.solar * hours) / 1000;
    this.stats.importedKwh += (totals.gridImport * hours) / 1000;
    this.stats.exportedKwh += (totals.gridExport * hours) / 1000;

    if (totals.consumption > this.stats.peakToday) {
      this.stats.peakToday = totals.consumption;
      this.stats.peakTodayAt = now;
    }

    let solarPeak = null;
    if (totals.solar > this.stats.solarPeakToday && totals.solar >= this.solarStartThreshold) {
      solarPeak = { watts: totals.solar, previous: this.stats.solarPeakToday };
      this.stats.solarPeakToday = totals.solar;
      this.stats.solarPeakTodayAt = now;
    }

    return { solarPeak };
  }

  /** Rounded copy of the daily statistics for the API. */
  get today() {
    return {
      peak: round(this.stats.peakToday),
      peakAt: this.stats.peakTodayAt,
      solarPeak: round(this.stats.solarPeakToday),
      solarPeakAt: this.stats.solarPeakTodayAt,
      consumedKwh: round(this.stats.consumedKwh, 2),
      producedKwh: round(this.stats.producedKwh, 2),
      importedKwh: round(this.stats.importedKwh, 2),
      exportedKwh: round(this.stats.exportedKwh, 2),
    };
  }

  toJSON() {
    return { version: 1, day: this.day, stats: this.stats };
  }

  fromJSON(snapshot) {
    if (!snapshot || snapshot.version !== 1) return false;
    if (snapshot.day !== startOfDay()) return false; // A new day starts from zero.
    this.day = snapshot.day;
    this.stats = { ...this.stats, ...snapshot.stats };
    return true;
  }

}

module.exports = EnergyAggregator;
