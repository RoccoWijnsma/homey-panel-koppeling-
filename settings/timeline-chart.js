/**
 * TimelineChart - a dependency free canvas renderer for the Energy Insights timeline.
 *
 * Why hand written instead of a charting library: the annotation layer is the point of this app.
 * Event markers need their own lane, clustering, hit testing and a tooltip that can show a "why"
 * sentence, and the chart has to redraw smoothly every few seconds inside Homey's webview on a
 * phone. A focused ~700 line renderer does that in a fraction of the bytes a generic library
 * would cost, and it keeps full control over how peaks are drawn.
 *
 * Rendering is dirty-flag driven: data updates and pointer moves only schedule a frame, so a live
 * feed never draws more than once per animation frame.
 *
 * The same file is served to the app settings page and to the Homey dashboard widget.
 */
(function attach(global) {
  'use strict';

  const SERIES = ['solar', 'consumption', 'net'];

  /** Candidate spacings for the time axis, from one second to six hours. */
  const TIME_STEPS = [
    1e3, 5e3, 10e3, 15e3, 30e3,
    60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3,
    3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3,
  ];

  /**
   * Fallback palette, used when the page exposes no CSS custom properties.
   * These are the light-mode values validated for colour-vision separation; the page overrides
   * them per theme through --ei-* variables (see style.css).
   */
  const DEFAULT_THEME = {
    text: '#0b0b0b',
    muted: '#52514e',
    grid: 'rgba(82,81,78,0.16)',
    axis: 'rgba(82,81,78,0.38)',
    surface: '#ffffff',
    tooltip: 'rgba(11,11,11,0.93)',
    tooltipText: '#ffffff',
    consumption: '#2a78d6',
    consumptionFill: 'rgba(42,120,214,0.14)',
    solar: '#eda100',
    solarFill: 'rgba(237,161,0,0.18)',
    net: '#1baf7a',
    peak: 'rgba(227,73,72,0.30)',
    markerColors: {
      blue: '#2a78d6',
      amber: '#eda100',
      teal: '#1baf7a',
      red: '#e34948',
      grey: '#52514e',
    },
  };

  /** Events that mark an ending are drawn as an outline instead of a filled dot. */
  const ENDING_TYPES = new Set(['device_off', 'solar_end', 'feed_in_end']);

  /**
   * Round a range up to a human friendly step (1, 1.5, 2, 2.5, 3, 5, 7.5 x 10^n).
   * The ladder is deliberately finer than the usual 1/2/5: with only three coarse rungs a
   * 3.9 kW peak snaps the axis all the way to 6 kW and the plot ends up half empty.
   */
  function niceStep(range, targetTicks) {
    if (!(range > 0)) return 1;
    const raw = range / Math.max(1, targetTicks);
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const normalised = raw / magnitude;
    const ladder = [1, 1.5, 2, 2.5, 3, 5, 7.5, 10];
    const step = ladder.find((candidate) => normalised <= candidate) || 10;
    return step * magnitude;
  }

  /** Align a timestamp to a step boundary in *local* time, so ticks land on round clock times. */
  function alignTime(time, step) {
    const offset = new Date(time).getTimezoneOffset() * 60000;
    return Math.ceil((time - offset) / step) * step + offset;
  }

  function formatClock(time, withSeconds) {
    const date = new Date(time);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    if (!withSeconds) return `${hours}:${minutes}`;
    return `${hours}:${minutes}:${String(date.getSeconds()).padStart(2, '0')}`;
  }

  function formatWatts(value) {
    const watts = Number(value) || 0;
    if (Math.abs(watts) >= 1000) return `${(watts / 1000).toFixed(Math.abs(watts) >= 10000 ? 0 : 1)} kW`;
    return `${Math.round(watts)} W`;
  }

  function roundRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  class TimelineChart {

    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} [options]
     * @param {boolean} [options.compact] Widget mode: smaller type, no axis titles.
     * @param {boolean} [options.interactive] Enable pan, zoom and the tooltip.
     * @param {(markers:Array)=>void} [options.onMarkerClick]
     * @param {(range:{from:number,to:number,follow:boolean})=>void} [options.onRangeChange]
     */
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.context = canvas.getContext('2d');
      this.compact = Boolean(options.compact);
      this.interactive = options.interactive !== false;
      this.onMarkerClick = options.onMarkerClick || null;
      this.onRangeChange = options.onRangeChange || null;

      this.theme = { ...DEFAULT_THEME };
      this.series = { t: [], consumption: [], solar: [], net: [], peak: [] };
      this.markers = [];
      this.visible = { consumption: true, solar: true, net: true };

      this.from = Date.now() - 15 * 60 * 1000;
      this.to = Date.now();
      this.follow = true;
      this.minSpan = 60 * 1000;
      this.maxSpan = 48 * 3600 * 1000;
      this.emptyText = '';

      this._pointer = null;
      this._drag = null;
      this._frame = null;
      this._hitAreas = [];

      this._onResize = () => this.resize();
      global.addEventListener('resize', this._onResize);
      if (this.interactive) this._bindPointer();

      this.readTheme();
      this.resize();
    }

    /* ------------------------------------------------------------------ setup */

    /** Pull the palette out of CSS custom properties so the canvas follows the page theme. */
    readTheme() {
      const styles = global.getComputedStyle(this.canvas);
      const pick = (name, fallback) => {
        const value = styles.getPropertyValue(name);
        return value && value.trim() ? value.trim() : fallback;
      };

      this.theme = {
        ...DEFAULT_THEME,
        text: pick('--ei-text', DEFAULT_THEME.text),
        muted: pick('--ei-muted', DEFAULT_THEME.muted),
        grid: pick('--ei-grid', DEFAULT_THEME.grid),
        axis: pick('--ei-axis', DEFAULT_THEME.axis),
        surface: pick('--ei-surface', DEFAULT_THEME.surface),
        tooltip: pick('--ei-tooltip', DEFAULT_THEME.tooltip),
        tooltipText: pick('--ei-tooltip-text', DEFAULT_THEME.tooltipText),
        consumption: pick('--ei-usage', DEFAULT_THEME.consumption),
        consumptionFill: pick('--ei-usage-fill', DEFAULT_THEME.consumptionFill),
        solar: pick('--ei-solar', DEFAULT_THEME.solar),
        solarFill: pick('--ei-solar-fill', DEFAULT_THEME.solarFill),
        net: pick('--ei-net', DEFAULT_THEME.net),
        peak: pick('--ei-peak', DEFAULT_THEME.peak),
        markerColors: {
          blue: pick('--ei-usage', DEFAULT_THEME.markerColors.blue),
          amber: pick('--ei-solar', DEFAULT_THEME.markerColors.amber),
          teal: pick('--ei-net', DEFAULT_THEME.markerColors.teal),
          red: pick('--ei-status', DEFAULT_THEME.markerColors.red),
          grey: pick('--ei-muted', DEFAULT_THEME.markerColors.grey),
        },
      };
      this.invalidate();
    }

    /** Match the backing store to the CSS size and the device pixel ratio. */
    resize() {
      const ratio = Math.min(3, global.devicePixelRatio || 1);
      const width = this.canvas.clientWidth || 320;
      const height = this.canvas.clientHeight || 200;

      this.width = width;
      this.height = height;
      this.canvas.width = Math.round(width * ratio);
      this.canvas.height = Math.round(height * ratio);
      this.context.setTransform(ratio, 0, 0, ratio, 0, 0);

      this.padding = {
        top: this.compact ? 8 : 14,
        right: this.compact ? 6 : 12,
        bottom: this.compact ? 16 : 24,
        left: this.compact ? 34 : 46,
      };
      this.markerLane = this.compact ? 12 : 20;
      this.invalidate();
    }

    destroy() {
      global.removeEventListener('resize', this._onResize);
      if (this._frame) global.cancelAnimationFrame(this._frame);
      this._unbindPointer();
    }

    /* ------------------------------------------------------------------ data */

    /**
     * @param {object} data
     * @param {object} data.series Columnar arrays: t, consumption, solar, net, peak.
     * @param {Array} [data.markers]
     */
    setData(data) {
      if (data.series) this.series = data.series;
      if (data.markers) this.markers = data.markers;
      this.invalidate();
    }

    /** Append one live sample without refetching the whole window. */
    appendSample(sample) {
      const series = this.series;
      if (!series.t) return;
      const last = series.t.length - 1;
      if (last >= 0 && sample.t - series.t[last] < 1000) return;

      series.t.push(sample.t);
      series.consumption.push(sample.consumption);
      series.solar.push(sample.solar);
      series.net.push(sample.net);
      series.peak.push(sample.consumption);

      // Keep the array bounded; the backend is the source of truth for anything older.
      const span = this.to - this.from;
      while (series.t.length > 4 && series.t[0] < sample.t - span * 2) {
        for (const key of ['t', 'consumption', 'solar', 'net', 'peak']) series[key].shift();
      }

      if (this.follow) {
        this.to = sample.t;
        this.from = this.to - span;
      }
      this.invalidate();
    }

    addMarker(marker) {
      if (this.markers.some((existing) => existing.id === marker.id)) return;
      this.markers.push(marker);
      this.markers.sort((left, right) => left.t - right.t);
      this.invalidate();
    }

    setMarkers(markers) {
      this.markers = markers || [];
      this.invalidate();
    }

    setVisible(visible) {
      this.visible = { ...this.visible, ...visible };
      this.invalidate();
    }

    setEmptyText(text) {
      this.emptyText = text || '';
      this.invalidate();
    }

    /* ------------------------------------------------------------------ range */

    setRange(from, to, follow) {
      const span = Math.min(this.maxSpan, Math.max(this.minSpan, to - from));
      this.to = to;
      this.from = to - span;
      if (typeof follow === 'boolean') this.follow = follow;
      this._emitRange();
      this.invalidate();
    }

    setFollow(follow) {
      this.follow = Boolean(follow);
      if (this.follow) {
        const span = this.to - this.from;
        this.to = Date.now();
        this.from = this.to - span;
      }
      this._emitRange();
      this.invalidate();
    }

    zoomAt(factor, clientX) {
      const span = this.to - this.from;
      const next = Math.min(this.maxSpan, Math.max(this.minSpan, span * factor));
      if (next === span) return;

      const anchor = clientX === undefined ? this.to : this._timeAt(clientX);
      const ratio = (anchor - this.from) / span;
      this.from = anchor - next * ratio;
      this.to = this.from + next;

      if (this.to < Date.now() - 2000) this.follow = false;
      this._emitRange();
      this.invalidate();
    }

    panBy(deltaMs) {
      this.from += deltaMs;
      this.to += deltaMs;
      if (deltaMs !== 0) this.follow = false;
      this._emitRange();
      this.invalidate();
    }

    _emitRange() {
      if (this.onRangeChange) this.onRangeChange({ from: this.from, to: this.to, follow: this.follow });
    }

    /* ------------------------------------------------------------------ scales */

    get plot() {
      return {
        x: this.padding.left,
        y: this.padding.top + this.markerLane,
        width: Math.max(10, this.width - this.padding.left - this.padding.right),
        height: Math.max(10, this.height - this.padding.top - this.padding.bottom - this.markerLane),
      };
    }

    _x(time) {
      const plot = this.plot;
      return plot.x + ((time - this.from) / (this.to - this.from)) * plot.width;
    }

    _timeAt(x) {
      const plot = this.plot;
      return this.from + ((x - plot.x) / plot.width) * (this.to - this.from);
    }

    _y(value) {
      const plot = this.plot;
      const { min, max } = this._domain;
      return plot.y + plot.height - ((value - min) / (max - min)) * plot.height;
    }

    /** Y domain over the visible window, padded and snapped to a round step. */
    _computeDomain() {
      const { t } = this.series;
      let max = 0;
      let min = 0;

      for (let index = 0; index < t.length; index += 1) {
        if (t[index] < this.from || t[index] > this.to) continue;
        if (this.visible.consumption) {
          max = Math.max(max, this.series.consumption[index], this.series.peak?.[index] ?? 0);
        }
        if (this.visible.solar) max = Math.max(max, this.series.solar[index]);
        if (this.visible.net) {
          max = Math.max(max, this.series.net[index]);
          min = Math.min(min, this.series.net[index]);
        }
      }

      if (max === 0 && min === 0) max = 1000;
      const paddedMax = max * 1.06;
      const paddedMin = min * 1.06;
      const step = niceStep(paddedMax - paddedMin || 1000, this.compact ? 4 : 5);
      this._domain = {
        min: Math.floor(paddedMin / step) * step,
        max: Math.ceil(paddedMax / step) * step,
        step,
      };
      if (this._domain.max === this._domain.min) this._domain.max += step;
    }

    /* ------------------------------------------------------------------ drawing */

    invalidate() {
      if (this._frame) return;
      this._frame = global.requestAnimationFrame(() => {
        this._frame = null;
        this.draw();
      });
    }

    draw() {
      const context = this.context;
      if (!context) return;

      context.clearRect(0, 0, this.width, this.height);
      this._computeDomain();
      this._hitAreas = [];

      const hasData = this.series.t.some((time) => time >= this.from && time <= this.to);

      this._drawGrid();
      if (hasData) {
        if (this.visible.consumption) this._drawPeakEnvelope();
        if (this.visible.solar) this._drawArea('solar', this.theme.solar, this.theme.solarFill);
        if (this.visible.consumption) this._drawArea('consumption', this.theme.consumption, this.theme.consumptionFill);
        if (this.visible.net) this._drawNet();
      }
      this._drawMarkers();
      this._drawAxes();

      if (!hasData && this.emptyText) this._drawEmpty();
      if (this.interactive && this._pointer) this._drawCursor();
    }

    _drawGrid() {
      const context = this.context;
      const plot = this.plot;
      const { min, max, step } = this._domain;

      context.save();
      context.strokeStyle = this.theme.grid;
      context.lineWidth = 1;
      context.beginPath();
      for (let value = Math.ceil(min / step) * step; value <= max; value += step) {
        const y = Math.round(this._y(value)) + 0.5;
        context.moveTo(plot.x, y);
        context.lineTo(plot.x + plot.width, y);
      }
      context.stroke();

      // The zero line is what separates importing from feeding in, so it gets its own weight.
      if (min < 0) {
        context.beginPath();
        context.strokeStyle = this.theme.axis;
        context.lineWidth = 1;
        const zero = Math.round(this._y(0)) + 0.5;
        context.moveTo(plot.x, zero);
        context.lineTo(plot.x + plot.width, zero);
        context.stroke();
      }
      context.restore();
    }

    /** Faint band showing the highest value inside each decimated bucket. */
    _drawPeakEnvelope() {
      const { t, peak, consumption } = this.series;
      if (!peak || peak.length !== t.length) return;

      const context = this.context;
      const plot = this.plot;
      context.save();
      context.beginPath();
      context.rect(plot.x, plot.y, plot.width, plot.height);
      context.clip();
      context.strokeStyle = this.theme.peak;
      context.lineWidth = 1;
      context.beginPath();

      let started = false;
      let meaningful = false;
      for (let index = 0; index < t.length; index += 1) {
        if (t[index] < this.from || t[index] > this.to) continue;
        if (peak[index] > consumption[index] * 1.02) meaningful = true;
        const x = this._x(t[index]);
        const y = this._y(peak[index]);
        if (!started) {
          context.moveTo(x, y);
          started = true;
        } else {
          context.lineTo(x, y);
        }
      }
      if (meaningful) context.stroke();
      context.restore();
    }

    _drawArea(key, stroke, fill) {
      const { t } = this.series;
      const values = this.series[key];
      if (!values || !values.length) return;

      const context = this.context;
      const plot = this.plot;
      const baseline = this._y(Math.max(this._domain.min, 0));

      context.save();
      context.beginPath();
      context.rect(plot.x, plot.y, plot.width, plot.height);
      context.clip();

      const points = [];
      for (let index = 0; index < t.length; index += 1) {
        if (t[index] < this.from || t[index] > this.to) continue;
        points.push([this._x(t[index]), this._y(values[index])]);
      }
      if (points.length === 0) {
        context.restore();
        return;
      }

      context.beginPath();
      context.moveTo(points[0][0], baseline);
      for (const [x, y] of points) context.lineTo(x, y);
      context.lineTo(points[points.length - 1][0], baseline);
      context.closePath();
      context.fillStyle = fill;
      context.fill();

      context.beginPath();
      context.moveTo(points[0][0], points[0][1]);
      for (const [x, y] of points) context.lineTo(x, y);
      context.strokeStyle = stroke;
      context.lineWidth = this.compact ? 1.4 : 1.9;
      context.lineJoin = 'round';
      context.stroke();
      context.restore();
    }

    /**
     * Net grid power, as one dashed line in a single hue.
     *
     * Import versus feed-in is polarity, and polarity is already encoded by position: above the
     * zero line the home draws from the grid, below it the home feeds back. Re-colouring the line
     * per sign would put a second, weaker encoding on top of a perfect one - and the obvious
     * choice for it, red against green, is exactly the pair colour-blind viewers cannot separate.
     */
    _drawNet() {
      const { t, net } = this.series;
      if (!net || !net.length) return;

      const context = this.context;
      const plot = this.plot;
      context.save();
      context.beginPath();
      context.rect(plot.x, plot.y, plot.width, plot.height);
      context.clip();
      context.lineWidth = this.compact ? 1.4 : 2;
      context.lineJoin = 'round';
      context.strokeStyle = this.theme.net;
      context.setLineDash(this.compact ? [] : [6, 4]);

      context.beginPath();
      let started = false;
      for (let index = 0; index < t.length; index += 1) {
        if (t[index] < this.from || t[index] > this.to) continue;
        const x = this._x(t[index]);
        const y = this._y(net[index]);
        if (!started) {
          context.moveTo(x, y);
          started = true;
        } else {
          context.lineTo(x, y);
        }
      }
      context.stroke();
      context.setLineDash([]);
      context.restore();
    }

    /**
     * Event markers: a guide line down the plot and a glyph in the lane above it.
     *
     * Shape is a second encoding next to hue, so the lane stays readable for colour-blind
     * viewers and in print: a peak is a diamond, an event that *ended* is an outline, and
     * everything else is a filled dot. Markers closer than 14px are clustered into one glyph so
     * a busy minute stays readable, and the cluster keeps every marker for the tooltip.
     */
    _drawMarkers() {
      const context = this.context;
      const plot = this.plot;
      const laneY = this.padding.top + this.markerLane / 2;
      const clusters = [];

      for (const marker of this.markers) {
        if (marker.t < this.from || marker.t > this.to) continue;
        const x = this._x(marker.t);
        const last = clusters[clusters.length - 1];
        if (last && x - last.x <= 14) {
          last.markers.push(marker);
          last.x = (last.x * (last.markers.length - 1) + x) / last.markers.length;
        } else {
          clusters.push({ x, markers: [marker] });
        }
      }

      context.save();
      for (const cluster of clusters) {
        const primary = cluster.markers[cluster.markers.length - 1];
        const color = this.theme.markerColors[primary.color] || this.theme.markerColors.slate;
        const x = Math.round(cluster.x) + 0.5;

        context.beginPath();
        context.setLineDash(primary.type === 'peak' ? [4, 3] : [2, 3]);
        context.strokeStyle = color;
        context.globalAlpha = primary.type === 'peak' ? 0.7 : 0.4;
        context.lineWidth = primary.type === 'peak' ? 1.5 : 1;
        context.moveTo(x, plot.y);
        context.lineTo(x, plot.y + plot.height);
        context.stroke();
        context.setLineDash([]);
        context.globalAlpha = 1;

        const radius = this.compact ? 3 : 4.5;
        const isPeak = primary.type === 'peak';
        const isEnding = ENDING_TYPES.has(primary.type);

        context.beginPath();
        if (isPeak) {
          const size = radius + 1.5;
          context.moveTo(x, laneY - size);
          context.lineTo(x + size, laneY);
          context.lineTo(x, laneY + size);
          context.lineTo(x - size, laneY);
          context.closePath();
        } else {
          context.arc(x, laneY, radius, 0, Math.PI * 2);
        }

        if (isEnding) {
          context.fillStyle = this.theme.surface;
          context.fill();
          context.strokeStyle = color;
          context.lineWidth = 1.6;
          context.stroke();
        } else {
          context.fillStyle = color;
          context.fill();
        }

        if (cluster.markers.length > 1 && !this.compact) {
          context.beginPath();
          context.arc(x, laneY, radius + 3.5, 0, Math.PI * 2);
          context.strokeStyle = color;
          context.lineWidth = 1;
          context.stroke();
        }

        this._hitAreas.push({ x, y: laneY, radius: radius + 8, markers: cluster.markers });
      }
      context.restore();
    }

    _drawAxes() {
      const context = this.context;
      const plot = this.plot;
      const { min, max, step } = this._domain;

      context.save();
      context.fillStyle = this.theme.muted;
      context.font = `${this.compact ? 9 : 10}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      context.textAlign = 'right';
      context.textBaseline = 'middle';

      for (let value = Math.ceil(min / step) * step; value <= max; value += step) {
        const label = Math.abs(value) >= 1000 ? `${Math.round(value / 100) / 10}k` : String(Math.round(value));
        context.fillText(label, plot.x - 6, this._y(value));
      }

      const span = this.to - this.from;
      const targetTicks = Math.max(2, Math.floor(plot.width / (this.compact ? 64 : 88)));
      const timeStep = TIME_STEPS.find((candidate) => span / candidate <= targetTicks) || TIME_STEPS[TIME_STEPS.length - 1];
      const withSeconds = timeStep < 60e3;

      context.textAlign = 'center';
      context.textBaseline = 'top';
      let previousDay = null;
      for (let time = alignTime(this.from, timeStep); time <= this.to; time += timeStep) {
        const x = this._x(time);
        if (x < plot.x - 1 || x > plot.x + plot.width + 1) continue;

        context.strokeStyle = this.theme.grid;
        context.beginPath();
        context.moveTo(Math.round(x) + 0.5, plot.y + plot.height);
        context.lineTo(Math.round(x) + 0.5, plot.y + plot.height + 3);
        context.stroke();

        const day = new Date(time).getDate();
        const label = previousDay !== null && day !== previousDay && !this.compact
          ? `${new Date(time).toLocaleDateString(undefined, { weekday: 'short' })} ${formatClock(time, false)}`
          : formatClock(time, withSeconds);
        previousDay = day;
        context.fillText(label, x, plot.y + plot.height + 5);
      }
      context.restore();
    }

    _drawEmpty() {
      const context = this.context;
      const plot = this.plot;
      context.save();
      context.fillStyle = this.theme.muted;
      context.font = `${this.compact ? 10 : 12}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(this.emptyText, plot.x + plot.width / 2, plot.y + plot.height / 2);
      context.restore();
    }

    /* ------------------------------------------------------------------ cursor */

    /** Index of the sample closest to a timestamp, or -1 when the window is empty. */
    _nearestIndex(time) {
      const { t } = this.series;
      if (!t.length) return -1;
      let low = 0;
      let high = t.length - 1;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (t[mid] < time) low = mid + 1;
        else high = mid;
      }
      if (low > 0 && Math.abs(t[low - 1] - time) < Math.abs(t[low] - time)) return low - 1;
      return low;
    }

    _drawCursor() {
      const context = this.context;
      const plot = this.plot;
      const time = this._timeAt(this._pointer.x);
      const index = this._nearestIndex(time);
      if (index < 0) return;

      const sampleTime = this.series.t[index];
      if (sampleTime < this.from || sampleTime > this.to) return;
      const x = this._x(sampleTime);

      context.save();
      context.strokeStyle = this.theme.axis;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(Math.round(x) + 0.5, plot.y);
      context.lineTo(Math.round(x) + 0.5, plot.y + plot.height);
      context.stroke();

      const dots = [
        this.visible.consumption ? ['consumption', this.theme.consumption] : null,
        this.visible.solar ? ['solar', this.theme.solar] : null,
        this.visible.net ? ['net', this.theme.net] : null,
      ].filter(Boolean);

      for (const [key, color] of dots) {
        context.beginPath();
        context.arc(x, this._y(this.series[key][index]), 3, 0, Math.PI * 2);
        context.fillStyle = color;
        context.fill();
        context.strokeStyle = this.theme.surface;
        context.lineWidth = 1.5;
        context.stroke();
      }
      context.restore();

      this._drawTooltip(x, index, sampleTime);
    }

    _drawTooltip(x, index, sampleTime) {
      const context = this.context;
      const plot = this.plot;
      const labels = this.labels || { usage: 'Usage', solar: 'Solar', net: 'Net' };

      // Identity is carried by the swatch in front of each row, never by the text colour: a
      // tooltip full of coloured sentences is harder to read and fails contrast on some hues.
      const lines = [{ text: formatClock(sampleTime, this.to - this.from < 30 * 60e3), bold: true }];
      if (this.visible.consumption) {
        lines.push({
          text: `${labels.usage}  ${formatWatts(this.series.consumption[index])}`,
          swatch: this.theme.consumption,
        });
      }
      if (this.visible.solar) {
        lines.push({ text: `${labels.solar}  ${formatWatts(this.series.solar[index])}`, swatch: this.theme.solar });
      }
      if (this.visible.net) {
        lines.push({ text: `${labels.net}  ${formatWatts(this.series.net[index])}`, swatch: this.theme.net });
      }

      // Markers within a few pixels of the cursor get their story told in the tooltip.
      const tolerance = Math.max(this.to - this.from, 1) / Math.max(plot.width, 1) * 12;
      const nearby = this.markers.filter((marker) => Math.abs(marker.t - sampleTime) <= tolerance).slice(-3);
      for (const marker of nearby) {
        lines.push({
          text: marker.label,
          swatch: this.theme.markerColors[marker.color] || this.theme.markerColors.grey,
          diamond: marker.type === 'peak',
          separated: true,
        });
        if (marker.reason) {
          for (const chunk of this._wrap(marker.reason, 32)) lines.push({ text: chunk, muted: true, indent: true });
        }
      }

      const fontSize = this.compact ? 9 : 11;
      const swatchSize = 7;
      const gutter = swatchSize + 6;
      context.save();
      context.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      const textWidth = Math.max(...lines.map((line) => context.measureText(line.text).width));
      const width = Math.min(240, textWidth + gutter + 16);
      const height = lines.length * (fontSize + 4) + 10;

      let boxX = x + 12;
      if (boxX + width > plot.x + plot.width) boxX = x - width - 12;
      if (boxX < plot.x) boxX = plot.x;
      let boxY = plot.y + 6;
      if (boxY + height > plot.y + plot.height) boxY = Math.max(plot.y, plot.y + plot.height - height);

      context.fillStyle = this.theme.tooltip;
      roundRect(context, boxX, boxY, width, height, 6);
      context.fill();

      context.textAlign = 'left';
      context.textBaseline = 'top';
      let lineY = boxY + 6;
      for (const line of lines) {
        if (line.swatch) {
          context.globalAlpha = 1;
          context.fillStyle = line.swatch;
          const swatchY = lineY + (fontSize - swatchSize) / 2 + 1;
          if (line.diamond) {
            const half = swatchSize / 2;
            const centreX = boxX + 8 + half;
            const centreY = swatchY + half;
            context.beginPath();
            context.moveTo(centreX, centreY - half);
            context.lineTo(centreX + half, centreY);
            context.lineTo(centreX, centreY + half);
            context.lineTo(centreX - half, centreY);
            context.closePath();
            context.fill();
          } else {
            roundRect(context, boxX + 8, swatchY, swatchSize, swatchSize, 2);
            context.fill();
          }
        }

        context.fillStyle = this.theme.tooltipText;
        context.globalAlpha = line.muted ? 0.7 : 1;
        context.font = `${line.bold ? '600 ' : ''}${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        context.fillText(line.text, boxX + 8 + (line.swatch || line.indent ? gutter : 0), lineY);
        lineY += fontSize + 4;
      }
      context.restore();
    }

    _wrap(text, maxChars) {
      const words = String(text).split(' ');
      const lines = [];
      let current = '';
      for (const word of words) {
        if ((`${current} ${word}`).trim().length > maxChars && current) {
          lines.push(current);
          current = word;
        } else {
          current = (`${current} ${word}`).trim();
        }
      }
      if (current) lines.push(current);
      return lines.slice(0, 3);
    }

    /* ------------------------------------------------------------------ input */

    _bindPointer() {
      this._handlers = {
        down: (event) => {
          this.canvas.setPointerCapture?.(event.pointerId);
          const point = this._local(event);
          this._drag = { x: point.x, moved: false, from: this.from, to: this.to };
        },
        move: (event) => {
          const point = this._local(event);
          this._pointer = point;
          if (this._drag) {
            const dx = point.x - this._drag.x;
            if (Math.abs(dx) > 3) this._drag.moved = true;
            const span = this._drag.to - this._drag.from;
            const shift = (-dx / this.plot.width) * span;
            this.from = this._drag.from + shift;
            this.to = this._drag.to + shift;
            if (this._drag.moved) this.follow = false;
            this._emitRange();
          }
          this.invalidate();
        },
        up: (event) => {
          const point = this._local(event);
          if (this._drag && !this._drag.moved) this._click(point);
          this._drag = null;
        },
        leave: () => {
          this._pointer = null;
          this._drag = null;
          this.invalidate();
        },
        wheel: (event) => {
          event.preventDefault();
          const point = this._local(event);
          this.zoomAt(event.deltaY > 0 ? 1.25 : 0.8, point.x);
        },
      };

      this.canvas.addEventListener('pointerdown', this._handlers.down);
      this.canvas.addEventListener('pointermove', this._handlers.move);
      this.canvas.addEventListener('pointerup', this._handlers.up);
      this.canvas.addEventListener('pointercancel', this._handlers.leave);
      this.canvas.addEventListener('pointerleave', this._handlers.leave);
      this.canvas.addEventListener('wheel', this._handlers.wheel, { passive: false });
    }

    _unbindPointer() {
      if (!this._handlers) return;
      this.canvas.removeEventListener('pointerdown', this._handlers.down);
      this.canvas.removeEventListener('pointermove', this._handlers.move);
      this.canvas.removeEventListener('pointerup', this._handlers.up);
      this.canvas.removeEventListener('pointercancel', this._handlers.leave);
      this.canvas.removeEventListener('pointerleave', this._handlers.leave);
      this.canvas.removeEventListener('wheel', this._handlers.wheel);
      this._handlers = null;
    }

    _local(event) {
      const rect = this.canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    _click(point) {
      if (!this.onMarkerClick) return;
      for (const area of this._hitAreas) {
        const dx = point.x - area.x;
        const dy = point.y - area.y;
        if (dx * dx + dy * dy <= area.radius * area.radius) {
          this.onMarkerClick(area.markers);
          return;
        }
      }
    }

  }

  TimelineChart.formatWatts = formatWatts;
  TimelineChart.formatClock = formatClock;
  TimelineChart.SERIES = SERIES;

  global.TimelineChart = TimelineChart;
}(typeof window !== 'undefined' ? window : globalThis));
