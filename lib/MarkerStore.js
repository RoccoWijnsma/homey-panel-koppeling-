'use strict';

const { LIMITS, MARKER_COLOR, MARKER_TYPE } = require('./constants');
const { uid } = require('./util');

/**
 * Bounded store of timeline annotations.
 *
 * Markers are written at a low rate (a device switching, a detected peak, a Flow action), so a
 * plain array is the right structure here - but it is hard capped on both count and age so it can
 * never grow without bound, and it is the only part of the timeline that is persisted verbatim.
 */
class MarkerStore {

  /**
   * @param {object} [options]
   * @param {number} [options.capacity] Maximum number of markers kept.
   * @param {number} [options.retentionMs] Maximum age of a marker.
   * @param {number} [options.dedupeMs] Window in which an identical marker is suppressed.
   */
  constructor({ capacity = 400, retentionMs = 48 * 3600 * 1000, dedupeMs = 5000 } = {}) {
    this.capacity = Math.min(LIMITS.maxMarkers, Math.max(10, capacity));
    this.retentionMs = retentionMs;
    this.dedupeMs = dedupeMs;
    /** @type {Array<object>} Chronological, oldest first. */
    this._markers = [];
  }

  get length() {
    return this._markers.length;
  }

  configure({ capacity, retentionMs } = {}) {
    if (Number.isFinite(capacity)) this.capacity = Math.min(LIMITS.maxMarkers, Math.max(10, capacity));
    if (Number.isFinite(retentionMs)) this.retentionMs = retentionMs;
    this.prune();
  }

  /**
   * Add a marker.
   *
   * @param {object} marker
   * @param {string} marker.type One of {@link MARKER_TYPE}.
   * @param {string} marker.label Text shown on the timeline.
   * @param {number} [marker.t] Timestamp, defaults to now.
   * @returns {object|null} The stored marker, or null when it was suppressed as a duplicate.
   */
  add(marker) {
    const time = Number.isFinite(marker.t) ? marker.t : Date.now();
    const type = marker.type || MARKER_TYPE.CUSTOM;

    if (this._isDuplicate(type, marker.deviceId, marker.label, time)) return null;

    const stored = {
      id: marker.id || uid(),
      t: time,
      type,
      label: String(marker.label || ''),
      color: marker.color || MARKER_COLOR[type] || 'slate',
      watts: Number.isFinite(marker.watts) ? Math.round(marker.watts) : null,
      delta: Number.isFinite(marker.delta) ? Math.round(marker.delta) : null,
      deviceId: marker.deviceId || null,
      deviceName: marker.deviceName || null,
      reason: marker.reason || null,
      contributors: Array.isArray(marker.contributors) ? marker.contributors : undefined,
    };

    // Markers usually arrive in order; splice keeps the array sorted when they do not.
    if (this._markers.length === 0 || time >= this._markers[this._markers.length - 1].t) {
      this._markers.push(stored);
    } else {
      const index = this._markers.findIndex((candidate) => candidate.t > time);
      this._markers.splice(index === -1 ? this._markers.length : index, 0, stored);
    }

    this.prune();
    return stored;
  }

  /** Suppress a marker that repeats an identical one within the dedupe window. */
  _isDuplicate(type, deviceId, label, time) {
    for (let index = this._markers.length - 1; index >= 0; index -= 1) {
      const marker = this._markers[index];
      if (time - marker.t > this.dedupeMs) return false;
      if (marker.type === type && marker.deviceId === (deviceId || null) && marker.label === String(label || '')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Markers inside a window, newest last.
   *
   * @param {object} [options]
   * @param {number} [options.from]
   * @param {number} [options.to]
   * @param {number} [options.limit] Keeps the newest `limit` markers of the window.
   * @param {string[]} [options.types] Only these marker types.
   */
  list({ from = 0, to = Number.MAX_SAFE_INTEGER, limit = 500, types = null } = {}) {
    const result = [];
    for (const marker of this._markers) {
      if (marker.t < from || marker.t > to) continue;
      if (types && !types.includes(marker.type)) continue;
      result.push(marker);
    }
    return result.length > limit ? result.slice(result.length - limit) : result;
  }

  /** Most recent marker of a given type, or null. */
  latest(type) {
    for (let index = this._markers.length - 1; index >= 0; index -= 1) {
      if (this._markers[index].type === type) return this._markers[index];
    }
    return null;
  }

  remove(id) {
    const index = this._markers.findIndex((marker) => marker.id === id);
    if (index === -1) return false;
    this._markers.splice(index, 1);
    return true;
  }

  clear() {
    const removed = this._markers.length;
    this._markers = [];
    return removed;
  }

  /** Drop markers that are too old or over capacity. Called on every add. */
  prune(now = Date.now()) {
    const cutoff = now - this.retentionMs;
    let firstKept = 0;
    while (firstKept < this._markers.length && this._markers[firstKept].t < cutoff) firstKept += 1;
    if (firstKept > 0) this._markers.splice(0, firstKept);
    if (this._markers.length > this.capacity) {
      this._markers.splice(0, this._markers.length - this.capacity);
    }
  }

  toJSON() {
    return { version: 1, markers: this._markers };
  }

  fromJSON(snapshot) {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.markers)) return false;
    this._markers = snapshot.markers
      .filter((marker) => marker && Number.isFinite(marker.t))
      .sort((left, right) => left.t - right.t);
    this.prune();
    return this._markers.length > 0;
  }

}

module.exports = MarkerStore;
