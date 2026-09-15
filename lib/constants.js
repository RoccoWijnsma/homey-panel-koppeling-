'use strict';

/** Manifest id of this app. Used to keep our own mirror devices out of the statistics. */
const APP_ID = 'com.homey.energyinsights';

/**
 * How a device is accounted for in the energy balance.
 * AUTO lets {@link DeviceMonitor} classify the device from its class/energy metadata.
 */
const DEVICE_ROLE = {
  AUTO: 'auto',
  CONSUMER: 'consumer',
  SOLAR: 'solar',
  GRID: 'grid',
  BATTERY: 'battery',
  IGNORE: 'ignore',
};

/** Marker kinds drawn on the timeline. Kept as plain strings so they survive persistence. */
const MARKER_TYPE = {
  DEVICE_ON: 'device_on',
  DEVICE_OFF: 'device_off',
  PEAK: 'peak',
  SOLAR_PEAK: 'solar_peak',
  FEED_IN_START: 'feed_in_start',
  FEED_IN_END: 'feed_in_end',
  SOLAR_START: 'solar_start',
  SOLAR_END: 'solar_end',
  CUSTOM: 'custom',
};

/**
 * Colour keys understood by the dashboard renderer.
 *
 * Markers are coloured by the domain they belong to rather than by a per-type hue: device events
 * wear the usage colour, solar events the solar colour and grid events the net colour, so a
 * marker visually points at the line it explains. Peaks use the reserved status red. Whether an
 * event started or ended is carried by the marker's shape, never by a sixth hue - four chart
 * hues plus a neutral is the most a colour-vision-safe palette supports side by side.
 */
const MARKER_COLOR = {
  [MARKER_TYPE.DEVICE_ON]: 'blue',
  [MARKER_TYPE.DEVICE_OFF]: 'blue',
  [MARKER_TYPE.PEAK]: 'red',
  [MARKER_TYPE.SOLAR_PEAK]: 'amber',
  [MARKER_TYPE.FEED_IN_START]: 'teal',
  [MARKER_TYPE.FEED_IN_END]: 'teal',
  [MARKER_TYPE.SOLAR_START]: 'amber',
  [MARKER_TYPE.SOLAR_END]: 'amber',
  [MARKER_TYPE.CUSTOM]: 'grey',
};

/** Marker types that mark the *end* of something; drawn as an outline instead of a filled dot. */
const MARKER_ENDING = new Set([
  MARKER_TYPE.DEVICE_OFF,
  MARKER_TYPE.SOLAR_END,
  MARKER_TYPE.FEED_IN_END,
]);

/**
 * Storage tiers. Every tier is a pre-allocated ring buffer, so the memory footprint of the
 * timeline is constant for the lifetime of the app (~120 kB for the three tiers together).
 * Samples roll up from the finest tier into the coarser ones, which is what keeps a 48 hour
 * history renderable on a Homey Pro without ever growing the heap.
 */
const TIERS = [
  { id: 'live', interval: 5 * 1000, capacity: 1080 }, // 90 minutes at 5s
  { id: 'mid', interval: 60 * 1000, capacity: 720 }, // 12 hours at 1m
  { id: 'day', interval: 5 * 60 * 1000, capacity: 576 }, // 48 hours at 5m
];

/** Defaults for everything the user can tune from the app settings page. */
const DEFAULTS = {
  sampleInterval: 5, // seconds between timeline samples
  peakThreshold: 3000, // W, peak trigger level
  peakDelta: 750, // W, minimum rise above the baseline to call it a peak
  peakSource: 'consumption', // 'consumption' | 'net'
  peakCooldown: 120, // seconds between two detected peaks
  attributionWindow: 60, // seconds to look back when explaining a peak
  minMarkerPower: 150, // W, devices smaller than this do not get on/off markers
  markerRetentionHours: 48,
  markerCapacity: 400,
  trackDeviceSwitches: true,
  trackSolarEvents: true,
  solarStartThreshold: 50, // W, solar production considered "active" above this
  debug: false,
};

/** Hard limits that protect Homey regardless of what the user configures. */
const LIMITS = {
  minSampleInterval: 2,
  maxSampleInterval: 60,
  maxMarkers: 1000,
  maxDevices: 500,
  /** Ring length of per-device power samples kept for peak attribution. */
  deviceHistory: 24,
  /** Max points returned by a single /timeline call. */
  maxQueryPoints: 1500,
  /** Settings blob written to disk may never exceed this (Homey settings are not a database). */
  maxPersistBytes: 256 * 1024,
  /** Minimum ms between two realtime broadcasts to the dashboard. */
  broadcastInterval: 1000,
};

const SETTINGS_KEY = {
  CONFIG: 'config',
  ROLES: 'deviceRoles',
  SNAPSHOT: 'snapshot',
};

module.exports = {
  APP_ID,
  DEVICE_ROLE,
  MARKER_TYPE,
  MARKER_COLOR,
  MARKER_ENDING,
  TIERS,
  DEFAULTS,
  LIMITS,
  SETTINGS_KEY,
};
