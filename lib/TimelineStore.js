'use strict';

const SampleBuffer = require('./SampleBuffer');
const { TIERS, LIMITS } = require('./constants');

/**
 * Multi resolution store for the energy timeline.
 *
 * Every sample is fed into all tiers at once. A tier keeps a running accumulator for the bucket
 * it is currently filling and commits one averaged sample per bucket into its ring buffer, so a
 * 5 second live feed costs one write per 5 seconds in the live tier, one per minute in the mid
 * tier and one per 5 minutes in the day tier. Because every ring is pre-allocated, 48 hours of
 * history uses the same amount of memory as the first minute after boot.
 */
class TimelineStore {

  /**
   * @param {object} [options]
   * @param {Array<{id:string,interval:number,capacity:number}>} [options.tiers]
   */
  constructor({ tiers = TIERS } = {}) {
    this.tiers = tiers.map((tier) => ({
      id: tier.id,
      interval: tier.interval,
      buffer: new SampleBuffer(tier.capacity),
      accumulator: null,
    }));
  }

  /** The finest tier, which is the one the live view reads from. */
  get liveTier() {
    return this.tiers[0];
  }

  /**
   * Add one measurement to every tier.
   *
   * @param {{t:number,consumption:number,solar:number,net:number}} sample
   */
  ingest(sample) {
    const time = Number(sample.t) || Date.now();
    for (const tier of this.tiers) {
      const bucket = Math.floor(time / tier.interval) * tier.interval;
      if (tier.accumulator && tier.accumulator.bucket !== bucket) this._commit(tier);
      if (!tier.accumulator) {
        tier.accumulator = {
          bucket,
          count: 0,
          consumption: 0,
          solar: 0,
          net: 0,
          peak: -Infinity,
        };
      }
      const accumulator = tier.accumulator;
      accumulator.count += 1;
      accumulator.consumption += sample.consumption;
      accumulator.solar += sample.solar;
      accumulator.net += sample.net;
      if (sample.consumption > accumulator.peak) accumulator.peak = sample.consumption;
    }
  }

  /** Write the pending accumulator of a tier into its ring buffer. */
  _commit(tier) {
    const accumulator = tier.accumulator;
    tier.accumulator = null;
    if (!accumulator || accumulator.count === 0) return;
    tier.buffer.push(
      accumulator.bucket,
      accumulator.consumption / accumulator.count,
      accumulator.solar / accumulator.count,
      accumulator.net / accumulator.count,
      accumulator.peak,
    );
  }

  /** The not yet committed bucket of a tier, so the chart can draw right up to "now". */
  _pending(tier) {
    const accumulator = tier.accumulator;
    if (!accumulator || accumulator.count === 0) return null;
    return {
      t: accumulator.bucket,
      consumption: Math.round(accumulator.consumption / accumulator.count),
      solar: Math.round(accumulator.solar / accumulator.count),
      net: Math.round(accumulator.net / accumulator.count),
      peak: Math.round(accumulator.peak),
    };
  }

  /**
   * Pick the finest tier that both covers `from` and does not explode the point count.
   * Falls back to the tier with the longest history when nothing covers the window yet.
   */
  _selectTier(from, to, maxPoints) {
    const withData = this.tiers.filter((tier) => tier.buffer.length > 0 || tier.accumulator);
    if (withData.length === 0) return this.liveTier;

    for (const tier of withData) {
      const rawPoints = (to - from) / tier.interval;
      if (rawPoints > maxPoints * 4) continue;
      const first = tier.buffer.firstTime();
      if (first === null || first <= from + tier.interval) return tier;
    }
    return withData[withData.length - 1];
  }

  /**
   * Read a window of the timeline.
   *
   * @param {object} options
   * @param {number} options.from Start timestamp.
   * @param {number} options.to End timestamp.
   * @param {number} [options.maxPoints] Maximum number of points to return.
   * @returns {{tier:string,interval:number,from:number,to:number,series:object}}
   */
  query({ from, to, maxPoints = 600 }) {
    const points = Math.min(LIMITS.maxQueryPoints, Math.max(10, Math.floor(maxPoints)));
    const tier = this._selectTier(from, to, points);
    const series = tier.buffer.read(from, to, points);

    // Append the bucket that is still being filled so the live view is never one bucket behind.
    const pending = this._pending(tier);
    if (pending && pending.t >= from && pending.t <= to) {
      const lastIndex = series.t.length - 1;
      if (lastIndex >= 0 && series.t[lastIndex] === pending.t) {
        series.consumption[lastIndex] = pending.consumption;
        series.solar[lastIndex] = pending.solar;
        series.net[lastIndex] = pending.net;
        series.peak[lastIndex] = pending.peak;
      } else {
        series.t.push(pending.t);
        series.consumption.push(pending.consumption);
        series.solar.push(pending.solar);
        series.net.push(pending.net);
        series.peak.push(pending.peak);
      }
    }

    return {
      tier: tier.id,
      interval: tier.interval,
      from,
      to,
      count: series.t.length,
      series,
    };
  }

  /** Oldest timestamp available in any tier. */
  get oldest() {
    let oldest = null;
    for (const tier of this.tiers) {
      const first = tier.buffer.firstTime();
      if (first !== null && (oldest === null || first < oldest)) oldest = first;
    }
    return oldest;
  }

  /** Approximate heap usage of the timeline, reported by /diagnostics. */
  get bytes() {
    return this.tiers.reduce((total, tier) => total + tier.buffer.bytes, 0);
  }

  /**
   * Snapshot for persistence. Only the coarsest tier is stored: it holds the longest history for
   * the fewest bytes, and a restart does not need second-level detail from before the restart.
   */
  toJSON() {
    const coarsest = this.tiers[this.tiers.length - 1];
    return {
      version: 1,
      tier: coarsest.id,
      interval: coarsest.interval,
      data: coarsest.buffer.toJSON(),
    };
  }

  /** Restore a snapshot into the matching tier. Snapshots from another layout are discarded. */
  fromJSON(snapshot) {
    if (!snapshot || snapshot.version !== 1) return false;
    const tier = this.tiers.find((candidate) => candidate.id === snapshot.tier);
    if (!tier || tier.interval !== snapshot.interval) return false;
    tier.buffer.fromJSON(snapshot.data);
    return tier.buffer.length > 0;
  }

  clear() {
    for (const tier of this.tiers) {
      tier.buffer.clear();
      tier.accumulator = null;
    }
  }

}

module.exports = TimelineStore;
