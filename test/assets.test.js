'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));

describe('packaging', () => {

  it('serves the same chart engine to the settings page and the widget', () => {
    // Homey sandboxes widget assets, so the widget needs its own copy of the renderer. This test
    // is what stops the two from drifting apart.
    assert.equal(
      read('settings/timeline-chart.js'),
      read('widgets/energy-timeline/public/timeline-chart.js'),
      'widgets/energy-timeline/public/timeline-chart.js is stale - copy settings/timeline-chart.js over it',
    );
  });

  it('ships every image the manifest points at', () => {
    const app = JSON.parse(read('app.json'));

    for (const image of Object.values(app.images)) {
      assert.ok(exists(image.replace(/^\//, '')), `missing app image ${image}`);
    }
    for (const driver of app.drivers) {
      for (const image of Object.values(driver.images)) {
        assert.ok(exists(image.replace(/^\//, '')), `missing driver image ${image}`);
      }
    }
    for (const capability of Object.values(app.capabilities || {})) {
      if (capability.icon) assert.ok(exists(capability.icon.replace(/^\//, '')), `missing icon ${capability.icon}`);
    }
    assert.ok(exists('assets/icon.svg'));
    assert.ok(exists('drivers/energy-insights/assets/icon.svg'));
  });

  it('keeps app.json in sync with the compose sources', () => {
    const app = JSON.parse(read('app.json'));
    const compose = JSON.parse(read('.homeycompose/app.json'));

    assert.equal(app.id, compose.id);
    assert.equal(app.version, compose.version);
    assert.deepEqual(app.api, compose.api);

    const triggers = fs.readdirSync(path.join(ROOT, '.homeycompose/flow/triggers'))
      .map((file) => file.replace('.json', '')).sort();
    assert.deepEqual(app.flow.triggers.map((card) => card.id).sort(), triggers);

    const actions = fs.readdirSync(path.join(ROOT, '.homeycompose/flow/actions'))
      .map((file) => file.replace('.json', '')).sort();
    assert.deepEqual(app.flow.actions.map((card) => card.id).sort(), actions);
  });

  it('registers a run listener for every Flow card in the manifest', () => {
    const app = JSON.parse(read('app.json'));
    const source = read('app.js');

    for (const trigger of app.flow.triggers) {
      // Triggers either have a run listener or are fired with tokens only.
      assert.ok(
        source.includes(`'${trigger.id}'`),
        `app.js never references trigger ${trigger.id}`,
      );
    }
    for (const card of [...app.flow.conditions, ...app.flow.actions]) {
      assert.ok(source.includes(`'${card.id}'`), `app.js never references ${card.id}`);
    }
  });

});
