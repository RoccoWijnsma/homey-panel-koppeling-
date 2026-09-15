'use strict';

const Homey = require('homey');

/**
 * Driver for the single virtual device that mirrors the app's aggregated numbers into Homey.
 *
 * The device exists so the timeline is usable outside of the dashboard: its capabilities show up
 * in Insights, on the Homey dashboard and in Flow conditions without this app having to duplicate
 * any of that. Only one device makes sense, so pairing offers exactly one.
 */
class EnergyInsightsDriver extends Homey.Driver {

  async onInit() {
    this.log('Energy Insights driver initialised');
  }

  /**
   * Homey hides devices that are already added, so the list is empty after the first pairing.
   */
  async onPairListDevices() {
    return [
      {
        name: this.homey.__('device.name') || 'Energy Insights',
        data: { id: 'energy-insights-main' },
      },
    ];
  }

}

module.exports = EnergyInsightsDriver;
