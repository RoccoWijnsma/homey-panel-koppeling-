'use strict';

/**
 * Web API of Homey Energy Insights.
 *
 * Every handler is a thin adapter over the app instance: parsing and validation live here, all
 * behaviour lives in `/app.js` and `/lib`. Routes are declared in `app.json` under `"api"`.
 *
 * The dashboard fetches `/timeline` once per range change and then follows the realtime `state`
 * and `marker` events, so the polling load on Homey stays close to zero.
 */
module.exports = {

  /** GET /state - live power, solar, net and today's statistics. */
  async getState({ homey }) {
    return homey.app.getState();
  },

  /**
   * GET /timeline?from=&to=&points= - a window of the timeline plus the markers inside it.
   * Timestamps are milliseconds since epoch; `points` caps the number of samples returned.
   */
  async getTimeline({ homey, query }) {
    return homey.app.getTimeline({
      from: query.from,
      to: query.to,
      points: query.points,
    });
  },

  /** GET /markers?from=&to=&types=peak,device_on */
  async getMarkers({ homey, query }) {
    return homey.app.getMarkers(query);
  },

  /** POST /markers - add a custom annotation. Body: { label, color?, t?, watts? } */
  async addMarker({ homey, body }) {
    const label = String(body?.label || '').trim();
    if (!label) throw new Error('A marker needs a label');
    if (label.length > 120) throw new Error('Marker labels are limited to 120 characters');

    const marker = homey.app.addMarker({
      type: 'custom',
      label,
      color: body.color,
      t: Number(body.t) || Date.now(),
      watts: Number.isFinite(Number(body.watts)) ? Number(body.watts) : undefined,
    });

    if (!marker) throw new Error('An identical marker was just added');
    return marker;
  },

  /** DELETE /markers/:id */
  async deleteMarker({ homey, params }) {
    const removed = homey.app.markers.remove(params.id);
    if (!removed) throw new Error('Marker not found');
    homey.app.broadcast('markers-changed', { removed: params.id });
    return { removed: 1 };
  },

  /** DELETE /markers - clear the whole annotation layer. */
  async clearMarkers({ homey }) {
    const removed = homey.app.markers.clear();
    homey.app.broadcast('markers-changed', { cleared: true });
    return { removed };
  },

  /** GET /devices - every tracked device with its role and current power. */
  async getDevices({ homey }) {
    return homey.app.getDevices();
  },

  /** PUT /devices/:id/role - body: { role: 'auto'|'consumer'|'solar'|'grid'|'battery'|'ignore' } */
  async setDeviceRole({ homey, params, body }) {
    return homey.app.setDeviceRole(params.id, String(body?.role || 'auto'));
  },

  /** GET /config */
  async getConfig({ homey }) {
    return homey.app.config;
  },

  /** PUT /config - partial update, unknown keys are ignored and values are clamped. */
  async setConfig({ homey, body }) {
    const allowed = [
      'sampleInterval',
      'peakThreshold',
      'peakDelta',
      'peakSource',
      'peakCooldown',
      'attributionWindow',
      'minMarkerPower',
      'markerRetentionHours',
      'markerCapacity',
      'trackDeviceSwitches',
      'trackSolarEvents',
      'solarStartThreshold',
      'debug',
    ];

    const patch = {};
    for (const key of allowed) {
      if (body && Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key];
    }

    return homey.app.setConfig(patch);
  },

  /** GET /diagnostics - buffer sizes and memory use, for support questions. */
  async getDiagnostics({ homey }) {
    return homey.app.getDiagnostics();
  },

};
