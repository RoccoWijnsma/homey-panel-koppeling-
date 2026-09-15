const { chromium } = require('playwright-core');
const { launchOptions } = require('./launch');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, 'out');
const REPO = path.join(__dirname, '..', '..');
const stub = fs.readFileSync(path.join(__dirname, 'dashboard.js'), 'utf8')
  .split('const HOMEY_STUB = `')[1].split('`;')[0];

(async () => {
  const browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ viewport: { width: 900, height: 900 }, colorScheme: 'light', deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  await page.addInitScript({ path: path.join(__dirname, 'mock.js') });
  await page.addInitScript({ content: stub });
  await page.goto(`file://${path.join(REPO, 'settings/index.html')}`);
  await page.evaluate(() => window.onHomeyReady(window.Homey));
  await page.waitForTimeout(600);

  // Hover the chart where the AC peak sits, so the tooltip shows the "why" sentence.
  const box = await page.locator('#chart').boundingBox();
  await page.mouse.move(box.x + box.width * 0.775, box.y + box.height * 0.45);
  await page.waitForTimeout(350);
  await page.locator('.ei-canvas-wrap').screenshot({ path: path.join(OUT, 'tooltip.png') });
  console.log('wrote tooltip.png');

  await page.mouse.move(0, 0);
  await page.click('#tab-devices');
  await page.waitForTimeout(400);
  await page.locator('#panel-devices').screenshot({ path: path.join(OUT, 'devices.png') });
  console.log('wrote devices.png');

  await page.click('#tab-settings');
  await page.waitForTimeout(400);
  await page.locator('#panel-settings').screenshot({ path: path.join(OUT, 'settings.png') });
  console.log('wrote settings.png');

  // 24 hour range, which exercises the coarse tier + day labels.
  await page.click('#tab-timeline');
  await page.click('[data-range="86400000"]');
  await page.waitForTimeout(600);
  await page.locator('.ei-canvas-wrap').screenshot({ path: path.join(OUT, 'range-24h.png') });
  console.log('wrote range-24h.png');

  await browser.close();
})();
