'use strict';

const Homey = require('homey');

/**
 * Virtual device that mirrors the aggregated energy state into Homey capabilities.
 *
 * It is event driven: the app pushes a state object after every sample and the device only writes
 * the capabilities that actually changed, which keeps Insights free of thousands of identical
 * entries and keeps the write load off Homey's storage.
 */
class EnergyInsightsDevice extends Homey.Device {

  async onInit() {
    this._onState = (state) => this._update(state).catch((error) => this.error(error));
    this._onPeak = (peak) => this._onPeakDetected(peak).catch((error) => this.error(error));

    this.homey.app.events.on('state', this._onState);
    this.homey.app.events.on('peak', this._onPeak);

    await this._update(this.homey.app.getState());
    await this.setAvailable();
    this.log('Energy Insights device initialised');
  }

  async onUninit() {
    this._removeListeners();
  }

  async onDeleted() {
    this._removeListeners();
  }

  _removeListeners() {
    if (this._onState) this.homey.app.events.removeListener('state', this._onState);
    if (this._onPeak) this.homey.app.events.removeListener('peak', this._onPeak);
    this._onState = null;
    this._onPeak = null;
  }

  /** Write a capability only when its value actually moved. */
  async _set(capability, value) {
    if (value === null || value === undefined) return;
    if (this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch((error) => {
      this.error(`Could not set ${capability}:`, error.message);
    });
  }

  async _update(state) {
    if (!state) return;
    await this._set('measure_power', state.net);
    await this._set('measure_power.consumed', state.consumption);
    await this._set('measure_power.solar', state.solar);
    await this._set('energy_self_sufficiency', state.selfSufficiency);
    await this._set('alarm_generic.peak', Boolean(state.inPeak));
    if (state.peak?.reason) await this._set('energy_peak_reason', state.peak.reason);
  }

  async _onPeakDetected(peak) {
    if (peak?.reason) await this._set('energy_peak_reason', peak.reason);
  }

}

module.exports = EnergyInsightsDevice;
