'use strict';

/** Clamp a number into a range, returning the fallback for anything that is not finite. */
function clamp(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** Round to a fixed number of decimals without the floating point noise of toFixed(). */
function round(value, decimals = 0) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Fill {placeholders} in a localised template.
 * Interpolation is done here instead of relying on the i18n backend so the locale files stay
 * portable and a missing key can never throw at runtime.
 */
function format(template, values = {}) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match;
  });
}

/** Format Watts for display: 940 W, 3.4 kW, -1.2 kW. */
function formatWatts(watts) {
  const value = Number(watts) || 0;
  if (Math.abs(value) >= 1000) return `${round(value / 1000, 1)} kW`;
  return `${Math.round(value)} W`;
}

/**
 * Exponential moving average helper.
 * `timeConstant` and `dt` share the same unit; the resulting alpha is frame-rate independent,
 * so changing the sample interval does not change how fast the baseline follows.
 */
function ema(previous, value, dt, timeConstant) {
  if (!Number.isFinite(previous)) return value;
  if (!(timeConstant > 0)) return value;
  const alpha = 1 - Math.exp(-dt / timeConstant);
  return previous + alpha * (value - previous);
}

/** Collapse a promise rejection into a resolved value, for best-effort calls. */
async function tryCatch(promise, fallback = null) {
  try {
    return await promise;
  } catch (error) {
    return fallback;
  }
}

/** Short, collision-free enough id for markers. */
function uid(prefix = 'm') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Start of the local day for a timestamp, used for the "today" statistics. */
function startOfDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

module.exports = {
  clamp,
  round,
  format,
  formatWatts,
  ema,
  tryCatch,
  uid,
  startOfDay,
};
