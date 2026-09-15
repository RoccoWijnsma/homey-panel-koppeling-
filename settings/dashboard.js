/**
 * Dashboard controller for the Energy Insights settings page.
 *
 * Data flow: one /timeline fetch per range change, then the app's realtime `state` and `marker`
 * events keep everything current. That means the page costs Homey one HTTP call when you open it
 * and nothing at all while you watch it.
 */
/* global Homey, TimelineChart */

(function dashboard() {
  'use strict';

  const RANGES = [900000, 3600000, 21600000, 86400000];
  const ENDING_TYPES = ['device_off', 'solar_end', 'feed_in_end'];
  const CONFIG_FIELDS = [
    ['peakThreshold', 'number'],
    ['peakDelta', 'number'],
    ['sampleInterval', 'number'],
    ['minMarkerPower', 'number'],
    ['markerRetentionHours', 'number'],
    ['trackDeviceSwitches', 'boolean'],
    ['trackSolarEvents', 'boolean'],
  ];

  const state = {
    range: RANGES[0],
    follow: true,
    chart: null,
    config: null,
    markers: [],
    lastState: null,
    loading: false,
    devicesLoadedAt: 0,
  };

  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------------ helpers */

  /** Promise wrapper around Homey's callback style API, which works on every Homey version. */
  function api(method, path, body) {
    return new Promise((resolve, reject) => {
      Homey.api(method, path, body === undefined ? null : body, (error, result) => {
        if (error) reject(error instanceof Error ? error : new Error(error.message || String(error)));
        else resolve(result);
      });
    });
  }

  /** Localise with a fallback, so a missing key never blanks the interface. */
  function translate(key, fallback) {
    try {
      const value = Homey.__(key);
      if (value && value !== key) return value;
    } catch (error) {
      // Homey.__ is unavailable outside of the settings frame.
    }
    return fallback;
  }

  const formatWatts = (value) => TimelineChart.formatWatts(value);

  function formatTime(time) {
    const date = new Date(time);
    const today = new Date();
    const clock = TimelineChart.formatClock(time, false);
    if (date.toDateString() === today.toDateString()) return clock;
    return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${clock}`;
  }

  let toastTimer = null;
  function toast(message) {
    const element = $('toast');
    element.textContent = message;
    element.dataset.visible = 'true';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      element.dataset.visible = 'false';
    }, 3200);
  }

  /* ------------------------------------------------------------------ rendering */

  function renderState(live) {
    if (!live) return;
    state.lastState = live;

    $('stat-usage').textContent = formatWatts(live.consumption);
    $('stat-usage-sub').textContent = live.unmetered > 0
      ? `${formatWatts(live.unmetered)} unmetered`
      : `${live.devices || 0} devices`;

    $('stat-solar').textContent = formatWatts(live.solar);
    $('stat-solar-sub').textContent = live.today ? `${live.today.producedKwh} kWh today` : '';

    $('stat-net').textContent = formatWatts(Math.abs(live.net));
    $('stat-net-sub').textContent = live.net >= 0 ? '↓ importing' : '↑ feeding in';

    $('stat-peak').textContent = live.today ? formatWatts(live.today.peak) : '–';
    $('stat-peak-sub').textContent = live.today && live.today.peakAt ? formatTime(live.today.peakAt) : '';

    $('stat-self').textContent = `${Math.round(live.selfSufficiency)}%`;
    $('stat-self-sub').textContent = live.today ? `${live.today.consumedKwh} kWh used today` : '';

    $('stat-feed').textContent = formatWatts(live.gridExport);
    $('stat-feed-sub').textContent = live.today ? `${live.today.exportedKwh} kWh today` : '';

    $('legend-usage').textContent = formatWatts(live.consumption);
    $('legend-solar').textContent = formatWatts(live.solar);
    $('legend-net').textContent = formatWatts(live.net);

    const dot = $('connection');
    dot.dataset.state = live.inPeak ? 'peak' : 'live';
    dot.title = live.inPeak && live.peak ? live.peak.reason : `Updated ${formatTime(live.t)}`;
  }

  function renderEvents() {
    const list = $('events');
    const markers = state.markers.slice(-40).reverse();
    list.innerHTML = '';

    if (markers.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'ei-empty';
      empty.textContent = translate('settings.empty', 'Collecting data… events appear here as they happen.');
      list.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const marker of markers) {
      const item = document.createElement('li');
      item.className = 'ei-event';

      const dot = document.createElement('i');
      dot.className = 'ei-event-dot';
      dot.dataset.color = marker.color || 'grey';
      if (ENDING_TYPES.includes(marker.type)) dot.dataset.ending = 'true';

      const body = document.createElement('div');
      body.className = 'ei-event-body';

      const label = document.createElement('div');
      label.className = 'ei-event-label';
      label.textContent = marker.label;
      body.appendChild(label);

      if (marker.reason) {
        const reason = document.createElement('div');
        reason.className = 'ei-event-reason';
        reason.textContent = marker.reason;
        body.appendChild(reason);
      }

      const meta = document.createElement('div');
      meta.className = 'ei-event-meta';
      meta.textContent = formatTime(marker.t);
      if (marker.watts !== null && marker.watts !== undefined) {
        meta.textContent += ` · ${formatWatts(marker.watts)}`;
      }

      item.append(dot, body, meta);
      fragment.appendChild(item);
    }
    list.appendChild(fragment);
  }

  function renderDevices(payload) {
    const container = $('devices');
    container.innerHTML = '';

    if (!payload.devices.length) {
      container.innerHTML = `<div class="ei-empty">${translate('settings.devices.empty', 'No devices with a power meter were found yet.')}</div>`;
      return;
    }

    const roleLabels = {
      auto: translate('settings.devices.auto', 'Automatic'),
      consumer: translate('settings.devices.consumer', 'Consumer'),
      solar: translate('settings.devices.solar', 'Solar production'),
      grid: translate('settings.devices.grid', 'Grid meter'),
      battery: translate('settings.devices.battery', 'Battery'),
      ignore: translate('settings.devices.ignore', 'Ignore'),
    };

    const fragment = document.createDocumentFragment();
    for (const device of payload.devices) {
      const row = document.createElement('div');
      row.className = 'ei-device';

      const body = document.createElement('div');
      body.className = 'ei-device-body';

      const name = document.createElement('div');
      name.className = 'ei-device-name';
      const indicator = document.createElement('i');
      indicator.className = 'ei-onoff';
      indicator.dataset.on = String(device.onoff === true);
      name.append(indicator, document.createTextNode(device.name));

      const meta = document.createElement('div');
      meta.className = 'ei-device-meta';
      // Spell out what auto detection concluded, otherwise "Automatic" tells the user nothing.
      const roleNote = device.overridden
        ? `${translate('settings.devices.role', 'Role')}: ${roleLabels[device.role] || device.role}`
        : `auto: ${(roleLabels[device.detectedRole] || device.detectedRole).toLowerCase()}`;
      meta.textContent = [device.zone, device.class, roleNote].filter(Boolean).join(' · ');

      body.append(name, meta);

      const power = document.createElement('div');
      power.className = 'ei-device-power';
      power.textContent = device.metered ? formatWatts(device.power) : '–';

      const select = document.createElement('select');
      select.setAttribute('aria-label', `${translate('settings.devices.role', 'Role')}: ${device.name}`);
      for (const role of payload.roles) {
        const option = document.createElement('option');
        option.value = role;
        option.textContent = roleLabels[role] || role;
        if (device.overridden ? role === device.role : role === 'auto') option.selected = true;
        select.appendChild(option);
      }
      select.addEventListener('change', () => setRole(device.id, select.value));

      row.append(body, power, select);
      fragment.appendChild(row);
    }
    container.appendChild(fragment);
  }

  function renderConfig(config) {
    state.config = config;
    for (const [key, type] of CONFIG_FIELDS) {
      const input = $(`cfg-${key}`);
      if (!input) continue;
      if (type === 'boolean') input.checked = Boolean(config[key]);
      else input.value = config[key];
    }
  }

  /* ------------------------------------------------------------------ data */

  async function loadTimeline() {
    if (state.loading) return;
    state.loading = true;
    try {
      const to = Date.now();
      const from = to - state.range;
      const points = Math.min(900, Math.max(120, Math.round(window.innerWidth * 1.5)));
      const result = await api('GET', `/timeline?from=${from}&to=${to}&points=${points}`);

      state.markers = result.markers || [];
      state.chart.setData({ series: result.series, markers: state.markers });
      state.chart.setRange(from, to, state.follow);
      renderState(result.state);
      renderEvents();
    } catch (error) {
      toast(translate('settings.error', 'Could not load data from the app.'));
      // eslint-disable-next-line no-console
      console.error(error);
    } finally {
      state.loading = false;
    }
  }

  async function loadDevices(force) {
    if (!force && Date.now() - state.devicesLoadedAt < 5000) return;
    state.devicesLoadedAt = Date.now();
    try {
      renderDevices(await api('GET', '/devices'));
    } catch (error) {
      $('devices').innerHTML = `<div class="ei-empty">${translate('settings.error', 'Could not load data from the app.')}</div>`;
    }
  }

  async function loadDiagnostics() {
    try {
      const data = await api('GET', '/diagnostics');
      const tiers = data.tiers.map((tier) => `${tier.id} ${tier.samples}/${tier.capacity}`).join(' · ');
      $('diagnostics').textContent = [
        `${data.devices} devices · ${data.markers} markers`,
        `timeline ${Math.round(data.timelineBytes / 1024)} kB (${tiers})`,
        data.heapUsed ? `heap ${Math.round(data.heapUsed / 1048576)} MB` : null,
      ].filter(Boolean).join(' — ');
    } catch (error) {
      $('diagnostics').textContent = '–';
    }
  }

  async function setRole(id, role) {
    try {
      await api('PUT', `/devices/${encodeURIComponent(id)}/role`, { role });
      await loadDevices(true);
      toast('Role updated');
    } catch (error) {
      toast(error.message);
    }
  }

  async function saveConfig() {
    const patch = {};
    for (const [key, type] of CONFIG_FIELDS) {
      const input = $(`cfg-${key}`);
      if (!input) continue;
      patch[key] = type === 'boolean' ? input.checked : Number(input.value);
    }
    try {
      renderConfig(await api('PUT', '/config', patch));
      toast('Settings saved');
    } catch (error) {
      toast(error.message);
    }
  }

  async function addMarker() {
    const input = $('marker-label');
    const label = input.value.trim();
    if (!label) {
      input.focus();
      return;
    }
    try {
      await api('POST', '/markers', { label });
      input.value = '';
      toast('Marker added');
    } catch (error) {
      toast(error.message);
    }
  }

  async function clearMarkers() {
    try {
      await api('DELETE', '/markers');
      state.markers = [];
      state.chart.setMarkers([]);
      renderEvents();
      toast('Markers cleared');
    } catch (error) {
      toast(error.message);
    }
  }

  /* ------------------------------------------------------------------ wiring */

  function selectTab(name) {
    for (const tab of document.querySelectorAll('.ei-tab')) {
      const selected = tab.id === `tab-${name}`;
      tab.setAttribute('aria-selected', String(selected));
      $(tab.getAttribute('aria-controls')).hidden = !selected;
    }
    if (name === 'devices') loadDevices(true);
    if (name === 'settings') loadDiagnostics();
    if (name === 'timeline') state.chart.resize();
  }

  function setRange(range) {
    state.range = range;
    for (const chip of document.querySelectorAll('#ranges .ei-chip')) {
      chip.setAttribute('aria-pressed', String(Number(chip.dataset.range) === range));
    }
    state.follow = true;
    $('follow').setAttribute('aria-pressed', 'true');
    loadTimeline();
  }

  function bind() {
    for (const tab of document.querySelectorAll('.ei-tab')) {
      tab.addEventListener('click', () => selectTab(tab.id.replace('tab-', '')));
    }
    for (const chip of document.querySelectorAll('#ranges .ei-chip')) {
      chip.addEventListener('click', () => setRange(Number(chip.dataset.range)));
    }

    $('follow').addEventListener('click', () => {
      state.follow = !state.follow;
      $('follow').setAttribute('aria-pressed', String(state.follow));
      state.chart.setFollow(state.follow);
      if (state.follow) loadTimeline();
    });

    for (const item of document.querySelectorAll('.ei-legend-item')) {
      item.addEventListener('click', () => {
        const pressed = item.getAttribute('aria-pressed') !== 'true';
        item.setAttribute('aria-pressed', String(pressed));
        state.chart.setVisible({ [item.dataset.series]: pressed });
      });
    }

    $('add-marker').addEventListener('click', addMarker);
    $('marker-label').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') addMarker();
    });
    $('clear-markers').addEventListener('click', clearMarkers);
    $('save-config').addEventListener('click', saveConfig);

    // Re-read the palette when the system theme flips under the page.
    if (window.matchMedia) {
      const query = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => state.chart.readTheme();
      if (query.addEventListener) query.addEventListener('change', onChange);
      else if (query.addListener) query.addListener(onChange);
    }
  }

  function subscribe() {
    Homey.on('state', (live) => {
      renderState(live);
      state.chart.appendSample({
        t: live.t,
        consumption: live.consumption,
        solar: live.solar,
        net: live.net,
      });
    });

    Homey.on('marker', (marker) => {
      state.markers.push(marker);
      if (state.markers.length > 400) state.markers.shift();
      state.chart.addMarker(marker);
      renderEvents();
    });

    Homey.on('markers-changed', () => loadTimeline());
    Homey.on('config', (config) => renderConfig(config));
    Homey.on('devices', () => loadDevices(false));
  }

  /* ------------------------------------------------------------------ boot */

  window.onHomeyReady = async function onHomeyReady(ready) {
    window.Homey = ready;

    state.chart = new TimelineChart($('chart'), {
      onMarkerClick: (markers) => {
        const marker = markers[markers.length - 1];
        toast(marker.reason ? `${marker.label} — ${marker.reason}` : marker.label);
      },
      onRangeChange: ({ follow }) => {
        if (follow === state.follow) return;
        state.follow = follow;
        $('follow').setAttribute('aria-pressed', String(follow));
      },
    });
    state.chart.labels = {
      usage: translate('settings.legend.usage', 'Usage'),
      solar: translate('settings.legend.solar', 'Solar'),
      net: translate('settings.legend.net', 'Net'),
    };
    state.chart.setEmptyText(translate('settings.empty', 'Collecting data…'));

    bind();
    subscribe();

    try {
      renderConfig(await api('GET', '/config'));
    } catch (error) {
      // The dashboard still works with the app's defaults.
    }
    await loadTimeline();

    // A slow safety net: realtime events carry the load, this only repairs a missed event.
    setInterval(() => {
      if (state.follow && !document.hidden) loadTimeline();
    }, 60000);

    ready.ready();
  };
}());
