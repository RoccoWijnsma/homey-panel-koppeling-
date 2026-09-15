'use strict';

const NumericRing = require('./NumericRing');
const { LIMITS, MARKER_TYPE } = require('./constants');
const { ema, format, formatWatts, round } = require('./util');

/** Production must fall this far below the maximum before the maximum is called a peak. */
const SOLAR_PEAK_CONFIRM_RATIO = 0.85;
/** A later maximum is only annotated again if it beats the reported one by this factor... */
const SOLAR_PEAK_MIN_IMPROVEMENT = 1.1;
/** ...or if this much time has passed, which covers a broken, cloudy day. */
const SOLAR_PEAK_MIN_GAP_MS = 30 * 60 * 1000;

/**
 * Detects the events that get annotated on the timeline and explains *why* they happened.
 *
 * Peak detection runs against a slow exponential baseline instead of a fixed average, so a home
 * that idles at 200 W and one that idles at 2 kW both get sensible peaks. While a peak is active
 * the baseline is frozen, otherwise the peak would drag its own reference up and end early.
 *
 * The explanation is built by comparing every metered device against its own power from
 * `attributionWindow` seconds ago and ranking the risers, then folding in what solar did over the
 * same window. That is what produces lines like
 * "Peak caused by Air Conditioning starting while solar yield dropped by 800 W".
 */
class EventDetector {

  /**
   * @param {object} options
   * @param {object} options.config Live app configuration.
   * @param {import('./DeviceMonitor')} options.monitor
   * @param {(key:string, values?:object)=>string} options.translate
   */
  constructor({ config, monitor, translate }) {
    this.config = config;
    this.monitor = monitor;
    this.translate = translate || ((key) => key);

    this.baseline = NaN;
    this.inPeak = false;
    this.peakStartedAt = 0;
    this.peakEndedAt = 0;
    this.peakMax = 0;

    this.feedingIn = false;
    this.solarActive = false;

    // A solar maximum is only worth annotating once production has turned around, otherwise a
    // clear morning would place a "new peak" marker on every single sample of the rising curve.
    this._pendingSolarPeak = null;
    this._reportedSolarPeak = 0;
    this._reportedSolarPeakAt = 0;

    // Short history of the aggregated series, used to describe what solar did during a peak.
    this._solarHistory = new NumericRing(LIMITS.deviceHistory);
    this._netHistory = new NumericRing(LIMITS.deviceHistory);
  }

  /** Number of samples that cover the configured attribution window. */
  get _lookbackSteps() {
    const interval = Math.max(1, this.config.sampleInterval);
    return Math.max(1, Math.min(LIMITS.deviceHistory - 1, Math.round(this.config.attributionWindow / interval)));
  }

  /**
   * Feed one aggregated sample in and get back the events it produced.
   *
   * @param {object} totals Output of {@link EnergyAggregator#aggregate}.
   * @param {object} [options]
   * @param {number} [options.dtSeconds] Seconds since the previous sample.
   * @param {number} [options.now]
   * @param {{watts:number,previous:number}|null} [options.solarPeak] Milestone from the aggregator.
   * @returns {Array<object>} Detected events, each ready to become a marker.
   */
  update(totals, { dtSeconds = 5, now = Date.now(), solarPeak = null } = {}) {
    const events = [];
    const value = this.config.peakSource === 'net' ? totals.net : totals.consumption;

    this._detectPeak(value, totals, dtSeconds, now, events);
    if (this.config.trackSolarEvents) this._detectSolarEvents(totals, now, solarPeak, events);

    this._solarHistory.push(totals.solar);
    this._netHistory.push(totals.net);

    return events;
  }

  _detectPeak(value, totals, dtSeconds, now, events) {
    const { peakThreshold, peakDelta, peakCooldown } = this.config;

    if (!this.inPeak) {
      // Track the quiet level of the home. Frozen during a peak (see class docs).
      this.baseline = ema(this.baseline, value, dtSeconds, 120);

      const aboveBaseline = Number.isFinite(this.baseline) ? value - this.baseline : value;
      const cooledDown = now - this.peakEndedAt >= peakCooldown * 1000;

      if (value >= peakThreshold && aboveBaseline >= peakDelta && cooledDown) {
        this.inPeak = true;
        this.peakStartedAt = now;
        this.peakMax = value;

        const explanation = this.explain(totals, value, aboveBaseline);
        events.push({
          type: MARKER_TYPE.PEAK,
          t: now,
          watts: round(value),
          delta: round(aboveBaseline),
          baseline: round(this.baseline || 0),
          solar: totals.solar,
          net: totals.net,
          ...explanation,
        });
      }
      return;
    }

    if (value > this.peakMax) this.peakMax = value;
    // 10% hysteresis keeps a wobbling load from producing a burst of peak markers.
    if (value < peakThreshold * 0.9) {
      this.inPeak = false;
      this.peakEndedAt = now;
      this.baseline = value;
    }
  }

  _detectSolarEvents(totals, now, solarPeak, events) {
    const threshold = this.config.solarStartThreshold;

    if (totals.hasSolar) {
      const producing = totals.solar >= threshold;
      if (producing !== this.solarActive) {
        this.solarActive = producing;
        events.push({
          type: producing ? MARKER_TYPE.SOLAR_START : MARKER_TYPE.SOLAR_END,
          t: now,
          watts: totals.solar,
        });
      }

      this._trackSolarPeak(totals, now, solarPeak, events);
    }

    // Net feed-in: surplus production flowing back into the grid.
    const exporting = totals.net < -threshold;
    if (exporting !== this.feedingIn) {
      this.feedingIn = exporting;
      events.push({
        type: exporting ? MARKER_TYPE.FEED_IN_START : MARKER_TYPE.FEED_IN_END,
        t: now,
        watts: Math.abs(totals.net),
        solar: totals.solar,
        consumption: totals.consumption,
      });
    }
  }

  /**
   * Remember the highest solar production of the day and report it once production has clearly
   * come back down, so the marker lands on the actual peak moment instead of on the way up.
   */
  _trackSolarPeak(totals, now, solarPeak, events) {
    if (solarPeak) {
      // previous === 0 means the aggregator rolled over into a new day.
      if (solarPeak.previous === 0) {
        this._reportedSolarPeak = 0;
        this._reportedSolarPeakAt = 0;
      }
      if (!this._pendingSolarPeak || solarPeak.watts > this._pendingSolarPeak.watts) {
        this._pendingSolarPeak = { watts: solarPeak.watts, at: now, previous: solarPeak.previous };
      }
    }

    const pending = this._pendingSolarPeak;
    if (!pending || totals.solar >= pending.watts * SOLAR_PEAK_CONFIRM_RATIO) return;

    this._pendingSolarPeak = null;
    const improved = pending.watts >= this._reportedSolarPeak * SOLAR_PEAK_MIN_IMPROVEMENT;
    const spaced = now - this._reportedSolarPeakAt >= SOLAR_PEAK_MIN_GAP_MS;
    if (!improved && !spaced) return;

    this._reportedSolarPeak = pending.watts;
    this._reportedSolarPeakAt = now;
    events.push({
      type: MARKER_TYPE.SOLAR_PEAK,
      t: pending.at,
      watts: pending.watts,
      previous: pending.previous,
    });
  }

  /**
   * Work out which devices are responsible for a rise, and phrase it in the user's language.
   *
   * @param {object} totals
   * @param {number} value The peak value.
   * @param {number} rise How far above the baseline the value is.
   * @returns {{reason:string, contributors:Array, deviceId:?string, deviceName:?string, share:number, solarDelta:number}}
   */
  explain(totals, value, rise) {
    const steps = this._lookbackSteps;
    const windowMs = this.config.attributionWindow * 1000;
    const solarDelta = totals.solar - this._solarHistory.ago(steps);

    const recentlyOn = new Set(this.monitor.recentlyTurnedOn(windowMs).map((record) => record.id));
    const risers = this.monitor
      .getDeltas(steps, 25)
      .filter((entry) => entry.delta > 0 && entry.role !== 'solar' && entry.role !== 'grid');

    // A drop in solar production raises the net import just as much as a device switching on,
    // so it competes for the explanation on equal terms.
    const solarDrop = solarDelta < -25 ? -solarDelta : 0;
    const totalRise = risers.reduce((sum, entry) => sum + entry.delta, 0) + solarDrop;

    const contributors = risers.slice(0, 4).map((entry) => ({
      id: entry.id,
      name: entry.name,
      delta: round(entry.delta),
      power: round(entry.power),
      started: entry.startedFromStandby || recentlyOn.has(entry.id),
      share: totalRise > 0 ? round((entry.delta / totalRise) * 100) : 0,
    }));

    // Anything the metered devices cannot explain, when a grid meter tells us the real total.
    if (totals.hasGridMeter && totals.unmetered > Math.max(200, rise * 0.4) && contributors.length === 0) {
      contributors.push({
        id: null,
        name: this.translate('reason.unattributed'),
        delta: round(totals.unmetered),
        power: round(totals.unmetered),
        started: false,
        share: 100,
      });
    }

    const named = contributors.filter((entry) => entry.share >= 15).slice(0, 2);
    let reason;

    if (named.length > 0) {
      const cause = named
        .map((entry) => this.translate(entry.started ? 'reason.deviceStarting' : 'reason.deviceRising', {
          device: entry.name,
        }))
        .join(this.translate('reason.and'));
      reason = this.translate('reason.peakCausedBy', { cause });
    } else {
      reason = this.translate('reason.unknown', { watts: formatWatts(value) });
    }

    if (solarDrop >= 100) {
      reason += this.translate('reason.whileSolarDropped', { delta: formatWatts(solarDrop) });
    } else if (solarDelta >= 100) {
      reason += this.translate('reason.whileSolarRose', { delta: formatWatts(solarDelta) });
    } else if (totals.hasSolar && totals.solar < this.config.solarStartThreshold && named.length > 0) {
      reason += this.translate('reason.withoutSolar');
    }

    const primary = named[0] || null;
    return {
      reason,
      contributors,
      deviceId: primary ? primary.id : null,
      deviceName: primary ? primary.name : null,
      share: primary ? primary.share : 0,
      solarDelta: round(solarDelta),
    };
  }

  /** Reset the state machine, for example after the user changed the peak source. */
  reset() {
    this.baseline = NaN;
    this.inPeak = false;
    this.peakMax = 0;
  }

}

module.exports = EventDetector;

// Re-exported so callers can build marker labels without importing the constants twice.
module.exports.MARKER_TYPE = MARKER_TYPE;
module.exports.format = format;
