const { chromium } = require('playwright-core');
const { launchOptions } = require('./launch');
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

/** Stub of Homey's settings bridge so the real page can boot outside Homey. */
const HOMEY_STUB = `
window.__state = {
  t: Date.now(), consumption: 3620, solar: 980, net: 2640, gridImport: 2640, gridExport: 0,
  batteryCharge: 0, batteryDischarge: 0, meteredConsumers: 3380, unmetered: 240,
  selfSufficiency: 27, hasGridMeter: true, hasSolar: true, meteredDevices: 14, devices: 14,
  inPeak: true, baseline: 440, threshold: 3000, sampleInterval: 5,
  today: { peak: 3620, peakAt: Date.now() - 60000, solarPeak: 3410, solarPeakAt: Date.now() - 9000000,
           consumedKwh: 12.4, producedKwh: 18.9, importedKwh: 4.1, exportedKwh: 10.6 },
  peak: { t: Date.now() - 60000, watts: 3620, device: 'Air Conditioning',
          reason: 'Peak caused by Air Conditioning starting while solar yield dropped by 2.1 kW' }
};
window.onHomeyReadyStub = true;
window.Homey = {
  __: (key) => key,
  ready: () => { window.__ready = true; },
  on: () => {},
  api: (method, path, body, callback) => {
    if (method === 'GET' && path.startsWith('/timeline')) {
      const params = new URLSearchParams(path.split('?')[1]);
      const from = Number(params.get('from')); const to = Number(params.get('to'));
      const mock = window.buildMock(to, to - from, Math.max(5000, (to - from) / 700));
      return callback(null, { tier: 'live', interval: 5000, from, to, count: mock.series.t.length,
        series: mock.series, markers: mock.markers, now: to, oldest: from, state: window.__state });
    }
    if (method === 'GET' && path === '/config') {
      return callback(null, { peakThreshold: 3000, peakDelta: 750, sampleInterval: 5,
        minMarkerPower: 150, markerRetentionHours: 48, trackDeviceSwitches: true, trackSolarEvents: true });
    }
    if (method === 'GET' && path === '/devices') {
      return callback(null, { roles: ['auto','consumer','solar','grid','battery','ignore'], totals: window.__state,
        devices: [
          { id:'1', name:'P1 Smart Meter', zone:'Meterkast', class:'sensor', role:'grid', detectedRole:'grid', overridden:false, power:2640, onoff:null, metered:true },
          { id:'2', name:'Solar Panels', zone:'Roof', class:'solarpanel', role:'solar', detectedRole:'solar', overridden:false, power:980, onoff:true, metered:true },
          { id:'3', name:'Air Conditioning', zone:'Living room', class:'airconditioning', role:'consumer', detectedRole:'consumer', overridden:false, power:3300, onoff:true, metered:true },
          { id:'4', name:'EV Charger', zone:'Garage', class:'evcharger', role:'consumer', detectedRole:'consumer', overridden:true, power:0, onoff:false, metered:true },
          { id:'5', name:'Washing Machine', zone:'Utility', class:'washer', role:'consumer', detectedRole:'consumer', overridden:false, power:4, onoff:false, metered:true },
          { id:'6', name:'Heat Pump', zone:'Utility', class:'heatpump', role:'consumer', detectedRole:'consumer', overridden:false, power:180, onoff:true, metered:true }
        ] });
    }
    if (method === 'GET' && path === '/diagnostics') {
      return callback(null, { uptime: 8400, devices: 14, markers: 46, timelineBytes: 57024,
        tiers: [ {id:'live',interval:5000,samples:1080,capacity:1080}, {id:'mid',interval:60000,samples:504,capacity:720}, {id:'day',interval:300000,samples:210,capacity:576} ],
        heapUsed: 29360128, config: {} });
    }
    return callback(null, {});
  }
};
`;

(async () => {
  const browser = await chromium.launch(launchOptions());

  const views = [
    { name: 'mobile', width: 390, height: 1180, scheme: 'light' },
    { name: 'mobile', width: 390, height: 1180, scheme: 'dark' },
    { name: 'desktop', width: 900, height: 1250, scheme: 'light' },
    { name: 'desktop', width: 900, height: 1250, scheme: 'dark' },
  ];

  for (const view of views) {
    const context = await browser.newContext({
      viewport: { width: view.width, height: view.height },
      colorScheme: view.scheme,
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => console.error(`[${view.name}/${view.scheme}] PAGE ERROR:`, error.message));
    page.on('console', (msg) => { if (msg.type() === 'error') console.error(`[${view.name}/${view.scheme}] console:`, msg.text()); });

    await page.addInitScript({ path: path.join(__dirname, 'mock.js') });
    await page.addInitScript({ content: HOMEY_STUB });
    await page.goto(`file://${path.join(REPO, 'settings/index.html')}`);
    // The real page waits for Homey to call onHomeyReady; do that ourselves.
    await page.evaluate(() => window.onHomeyReady(window.Homey));
    await page.waitForTimeout(700);

    const file = path.join(OUT, `${view.name}-${view.scheme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log('wrote', file, await page.evaluate(() => window.__ready === true ? '(ready ok)' : '(NOT ready)'));
    await context.close();
  }

  await browser.close();
})();
