'use strict';

/**
 * Widget API.
 *
 * Widgets get their own namespace, so this is a deliberately minimal surface: the dashboard tile
 * only ever needs a window of the timeline, and it reuses the app's own bounded query path.
 */
module.exports = {

  /** GET /timeline?from=&to=&points= */
  async getTimeline({ homey, query }) {
    const result = homey.app.getTimeline({
      from: query.from,
      to: query.to,
      points: query.points,
    });

    // The tile has no room for a device list or diagnostics; keep the payload small.
    return {
      series: result.series,
      markers: result.markers,
      from: result.from,
      to: result.to,
      now: result.now,
      state: result.state,
    };
  },

};
