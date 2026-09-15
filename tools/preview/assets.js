const { chromium } = require('playwright-core');
const { launchOptions } = require('./launch');
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');

/** Promotional tile for the app store: the app's own visual language, at 10:7. */
const appTile = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;overflow:hidden;background:#0f1218;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}
  .tile{position:relative;width:100vw;height:100vh;
    background:radial-gradient(120% 90% at 8% 0%, #1d2534 0%, #0f1218 62%);overflow:hidden;}
  .copy{position:absolute;top:8.5%;left:6.5%;right:6.5%;}
  h1{margin:0;color:#fff;font-size:8.2vh;line-height:1.02;font-weight:680;letter-spacing:-0.025em;}
  p{margin:1.6vh 0 0;color:#aab3c2;font-size:3.9vh;font-weight:500;letter-spacing:-0.01em;}
  svg{position:absolute;left:0;bottom:0;width:100%;height:62%;}
</style></head><body><div class="tile">
  <div class="copy"><h1>Energy<br>Insights</h1><p>Every peak, explained.</p></div>
  <svg viewBox="0 0 1000 420" preserveAspectRatio="none">
    <defs>
      <linearGradient id="solar" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#EDA100" stop-opacity="0.42"/>
        <stop offset="1" stop-color="#EDA100" stop-opacity="0.02"/>
      </linearGradient>
      <linearGradient id="usage" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#3987E5" stop-opacity="0.40"/>
        <stop offset="1" stop-color="#3987E5" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    <path d="M0 404C140 350 270 168 470 140S830 214 1000 380v40H0z" fill="url(#solar)"/>
    <path d="M0 404C140 350 270 168 470 140S830 214 1000 380" fill="none"
      stroke="#EDA100" stroke-width="7" stroke-linecap="round"/>
    <path d="M0 372h250l18-128h104l18 128h132l16-196h104l16 196h326v48H0z" fill="url(#usage)"/>
    <path d="M0 372h250l18-128h104l18 128h132l16-196h104l16 196h326" fill="none"
      stroke="#3987E5" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M0 404c120-26 210-64 330-58s250 74 350 52 250-96 320-128" fill="none"
      stroke="#199E70" stroke-width="6" stroke-linecap="round" stroke-dasharray="22 14"/>
    <g opacity="0.85">
      <path d="M622 30v150" stroke="#D93A39" stroke-width="4" stroke-dasharray="9 9"/>
      <path d="M320 92v160" stroke="#3987E5" stroke-width="3" stroke-dasharray="6 8" opacity="0.7"/>
    </g>
    <path d="M622 0l28 28-28 28-28-28z" fill="#D93A39"/>
    <circle cx="320" cy="72" r="15" fill="#3987E5"/>
    <path d="M470 96v46" stroke="#EDA100" stroke-width="3" stroke-dasharray="6 8" opacity="0.7"/>
    <circle cx="470" cy="76" r="15" fill="#EDA100"/>
  </svg>
</div></body></html>`;

/** Square device tile for the virtual mirror device. */
const driverTile = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;overflow:hidden;}
  .tile{width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(85% 75% at 50% 18%, #ffffff 0%, #e9e9e5 100%);}
  svg{width:62%;height:62%;}
</style></head><body><div class="tile">
  <svg viewBox="0 0 64 64">
    <path d="M5 48h15l4.5-20h15l4.5 20h15" fill="none" stroke="#2A78D6" stroke-width="5"
      stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M32 12v16" stroke="#E34948" stroke-width="2.5" stroke-linecap="round"
      stroke-dasharray="3 4" opacity="0.85"/>
    <path d="M32 5l6.5 6.5L32 18l-6.5-6.5z" fill="#E34948"/>
  </svg>
</div></body></html>`;

const targets = [
  { html: appTile, out: 'assets/images/small.png', width: 250, height: 175 },
  { html: appTile, out: 'assets/images/large.png', width: 500, height: 350 },
  { html: appTile, out: 'assets/images/xlarge.png', width: 1000, height: 700 },
  { html: driverTile, out: 'drivers/energy-insights/assets/images/small.png', width: 75, height: 75 },
  { html: driverTile, out: 'drivers/energy-insights/assets/images/large.png', width: 500, height: 500 },
  { html: driverTile, out: 'drivers/energy-insights/assets/images/xlarge.png', width: 1000, height: 1000 },
];

(async () => {
  const browser = await chromium.launch(launchOptions());
  for (const target of targets) {
    const context = await browser.newContext({
      viewport: { width: target.width, height: target.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.setContent(target.html);
    await page.waitForTimeout(120);
    const file = path.join(REPO, target.out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file });
    console.log(`${target.out} ${target.width}x${target.height}`);
    await context.close();
  }
  await browser.close();
})();
