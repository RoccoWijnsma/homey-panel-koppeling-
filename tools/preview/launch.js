'use strict';

/**
 * Where to find a Chromium for the preview scripts.
 *
 * Set CHROMIUM_PATH when you have a browser outside of Playwright's own cache; otherwise install
 * one with `npx playwright install chromium` and let playwright-core find it.
 */
function launchOptions() {
  const executablePath = process.env.CHROMIUM_PATH;
  return executablePath ? { executablePath } : {};
}

module.exports = { launchOptions };
