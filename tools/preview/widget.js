const { chromium } = require('playwright-core');
const { launchOptions } = require('./launch');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const WIDGET = path.join(REPO, 'widgets/energy-timeline');

const STUB = `
window.Homey = {
  ready: () => { window.__ready = true; },
  getSettings: () => ({ range: '3600000', showMarkers: true, showNet: true }),
  on: () => {},
  api: (method, p, body, callback) => {
    const params = new URLSearchParams(p.split('?')[1]);
    const from = Number(params.get('from')); const to = Number(params.get('to'));
    const mock = window.buildMock(to, to - from, Math.max(5000, (to - from) / 400));
    callback(null, { series: mock.series, markers: mock.markers, from, to, now: to, state: {
      t: to, consumption: 3620, solar: 980, net: 2640,
      peak: { t: to - 120000, watts: 3620, reason: 'Peak caused by Air Conditioning starting while solar yield dropped by 2.1 kW' }
    }});
  }
};`;

(async () => {
  const browser = await chromium.launch(launchOptions());

  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: 400, height: 240 },
      colorScheme: scheme,
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => console.error(`[${scheme}] PAGE ERROR:`, error.message));
    await page.addInitScript({ path: path.join(__dirname, 'mock.js') });
    await page.addInitScript({ content: STUB });
    // Dashboard tiles sit on the Homey surface colour, so bake that into the preview.
    await page.addStyleTag; // no-op placeholder, style injected after load
    await page.goto(`file://${path.join(WIDGET, 'public/index.html')}`);
    await page.addStyleTag({ content: `html,body{background:${scheme === 'dark' ? '#1a1a19' : '#ffffff'} !important;}` });
    await page.evaluate(() => window.onHomeyReady(window.Homey));
    await page.waitForTimeout(700);

    const file = path.join(WIDGET, `preview-${scheme}.png`);
    await page.screenshot({ path: file });
    console.log('wrote', file, await page.evaluate(() => (window.__ready ? 'ready' : 'NOT READY')));
    await context.close();
  }

  await browser.close();
})();
