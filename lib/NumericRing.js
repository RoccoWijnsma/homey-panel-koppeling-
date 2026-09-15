'use strict';

/**
 * Tiny fixed-size ring of numbers backed by a Float32Array.
 *
 * Used for the short per-device power history that powers peak attribution. One instance costs
 * `capacity * 4` bytes, so even a household with 200 metered devices stays under 20 kB.
 */
class NumericRing {

  constructor(capacity) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this._values = new Float32Array(this.capacity);
    this._head = 0;
    this._count = 0;
  }

  get length() {
    return this._count;
  }

  push(value) {
    this._values[this._head] = Number.isFinite(value) ? value : 0;
    this._head = (this._head + 1) % this.capacity;
    if (this._count < this.capacity) this._count += 1;
  }

  /** Value `steps` samples before the newest one, clamped to the oldest sample we still have. */
  ago(steps) {
    if (this._count === 0) return 0;
    const offset = Math.min(Math.max(0, Math.floor(steps)), this._count - 1);
    const slot = (this._head - 1 - offset + this.capacity * 2) % this.capacity;
    return this._values[slot];
  }

  /** Newest value. */
  get last() {
    return this.ago(0);
  }

  /** Lowest value still in the ring, used to spot devices that started from standby. */
  min() {
    if (this._count === 0) return 0;
    let minimum = Infinity;
    for (let index = 0; index < this._count; index += 1) {
      const slot = (this._head - 1 - index + this.capacity * 2) % this.capacity;
      if (this._values[slot] < minimum) minimum = this._values[slot];
    }
    return minimum;
  }

  fill(value) {
    this._values.fill(Number.isFinite(value) ? value : 0);
    this._count = this.capacity;
    this._head = 0;
  }

}

module.exports = NumericRing;
