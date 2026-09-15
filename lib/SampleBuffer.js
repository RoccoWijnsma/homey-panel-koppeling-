'use strict';

/**
 * Fixed-size, columnar ring buffer for timeline samples.
 *
 * All storage is pre-allocated in typed arrays, so pushing a sample never allocates and the
 * memory footprint is constant: `capacity * 24 bytes`. Samples are always pushed in
 * chronological order, which lets range lookups use a binary search.
 */
class SampleBuffer {

  /**
   * @param {number} capacity Number of samples to keep.
   */
  constructor(capacity) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this._time = new Float64Array(this.capacity);
    this._consumption = new Float32Array(this.capacity);
    this._solar = new Float32Array(this.capacity);
    this._net = new Float32Array(this.capacity);
    /** Highest instantaneous consumption seen inside the sample's bucket. */
    this._peak = new Float32Array(this.capacity);
    this._head = 0;
    this._count = 0;
  }

  get length() {
    return this._count;
  }

  /** Bytes held by this buffer, for the diagnostics endpoint. */
  get bytes() {
    return this.capacity * (8 + 4 * 4);
  }

  /** Translate a logical index (0 = oldest) into a physical slot. */
  _slot(index) {
    return (this._head - this._count + index + this.capacity * 2) % this.capacity;
  }

  push(time, consumption, solar, net, peak) {
    const slot = this._head;
    this._time[slot] = time;
    this._consumption[slot] = consumption;
    this._solar[slot] = solar;
    this._net[slot] = net;
    this._peak[slot] = Number.isFinite(peak) ? peak : consumption;
    this._head = (this._head + 1) % this.capacity;
    if (this._count < this.capacity) this._count += 1;
  }

  timeAt(index) {
    return this._time[this._slot(index)];
  }

  sampleAt(index) {
    const slot = this._slot(index);
    return {
      t: this._time[slot],
      consumption: this._consumption[slot],
      solar: this._solar[slot],
      net: this._net[slot],
      peak: this._peak[slot],
    };
  }

  firstTime() {
    return this._count === 0 ? null : this.timeAt(0);
  }

  lastTime() {
    return this._count === 0 ? null : this.timeAt(this._count - 1);
  }

  /** Lowest logical index whose timestamp is >= time. */
  indexAtOrAfter(time) {
    let low = 0;
    let high = this._count;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.timeAt(mid) < time) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  /**
   * Read a time range as columnar arrays, decimated to at most `maxPoints` points.
   *
   * Decimation averages the three series but keeps the *maximum* consumption of every bucket in
   * the `peak` column, so zooming out never hides a spike - which is the whole point of this app.
   *
   * @param {number} from Start timestamp (inclusive).
   * @param {number} to End timestamp (inclusive).
   * @param {number} maxPoints Upper bound on returned points.
   * @returns {{t:number[],consumption:number[],solar:number[],net:number[],peak:number[]}}
   */
  read(from, to, maxPoints = 600) {
    const out = { t: [], consumption: [], solar: [], net: [], peak: [] };
    if (this._count === 0) return out;

    const start = this.indexAtOrAfter(from);
    let end = this.indexAtOrAfter(to);
    if (end < this._count && this.timeAt(end) <= to) end += 1;
    const total = end - start;
    if (total <= 0) return out;

    const stride = Math.max(1, Math.ceil(total / Math.max(1, maxPoints)));

    for (let index = start; index < end; index += stride) {
      const bucketEnd = Math.min(end, index + stride);
      let sumConsumption = 0;
      let sumSolar = 0;
      let sumNet = 0;
      let maxPeak = -Infinity;
      for (let cursor = index; cursor < bucketEnd; cursor += 1) {
        const slot = this._slot(cursor);
        sumConsumption += this._consumption[slot];
        sumSolar += this._solar[slot];
        sumNet += this._net[slot];
        if (this._peak[slot] > maxPeak) maxPeak = this._peak[slot];
      }
      const size = bucketEnd - index;
      out.t.push(this.timeAt(index));
      out.consumption.push(Math.round(sumConsumption / size));
      out.solar.push(Math.round(sumSolar / size));
      out.net.push(Math.round(sumNet / size));
      out.peak.push(Math.round(maxPeak));
    }

    return out;
  }

  /** Columnar snapshot for persistence. Values are rounded to whole Watts to keep it small. */
  toJSON() {
    const time = [];
    const consumption = [];
    const solar = [];
    const net = [];
    const peak = [];
    for (let index = 0; index < this._count; index += 1) {
      const slot = this._slot(index);
      time.push(Math.round(this._time[slot]));
      consumption.push(Math.round(this._consumption[slot]));
      solar.push(Math.round(this._solar[slot]));
      net.push(Math.round(this._net[slot]));
      peak.push(Math.round(this._peak[slot]));
    }
    return { t: time, c: consumption, s: solar, n: net, p: peak };
  }

  /** Restore a snapshot written by {@link SampleBuffer#toJSON}. Unknown shapes are ignored. */
  fromJSON(data) {
    if (!data || !Array.isArray(data.t)) return;
    const length = data.t.length;
    const skip = Math.max(0, length - this.capacity);
    for (let index = skip; index < length; index += 1) {
      this.push(
        Number(data.t[index]) || 0,
        Number(data.c?.[index]) || 0,
        Number(data.s?.[index]) || 0,
        Number(data.n?.[index]) || 0,
        Number(data.p?.[index]) || 0,
      );
    }
  }

  clear() {
    this._head = 0;
    this._count = 0;
  }

}

module.exports = SampleBuffer;
