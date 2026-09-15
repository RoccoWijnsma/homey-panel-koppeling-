'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  SHADE_CAPABILITIES,
  SHADE_TYPES,
  getCapabilities,
  getHomeyCapabilities,
  getTypeName,
} = require('../lib/shade-types');

describe('the shade type table', () => {
  it('names a known type', () => {
    assert.equal(getTypeName(6), 'Duette');
    assert.equal(getTypeName(47), 'Pleated, Top Down Bottom Up');
  });

  it('says something useful about a type it does not know', () => {
    assert.equal(getTypeName(200), 'PowerView Shade (type 200)');
    assert.equal(getTypeName(null), 'PowerView Shade');
  });

  it('gives every type with declared capabilities a name too', () => {
    for (const typeId of Object.keys(SHADE_CAPABILITIES)) {
      assert.ok(SHADE_TYPES[typeId], `type ${typeId} has capabilities but no name`);
    }
  });

  it('falls back to plain lift for a type it does not know', () => {
    // Same fallback the gateway API uses, so an unlisted shade still works.
    assert.deepEqual(getCapabilities(200), getCapabilities(null));
    assert.equal(getCapabilities(200).hasTilt, false);
  });
});

describe('the capabilities a shade is created with', () => {
  it('gives a plain shade a position, a state and a battery', () => {
    assert.deepEqual(getHomeyCapabilities(6), [
      'powerview_open',
      'powerview_status',
      'windowcoverings_set',
      'windowcoverings_state',
      'measure_battery',
    ]);
  });

  it('offers a one-tap open and a spelled-out position wherever it lifts', () => {
    assert.ok(getHomeyCapabilities(6).includes('powerview_open'));
    assert.ok(getHomeyCapabilities(6).includes('powerview_status'));
  });

  it('offers neither to a shade that only tilts', () => {
    // There is no lift axis to open, and nothing to describe as a percentage.
    assert.ok(!getHomeyCapabilities(39).includes('powerview_open'));
    assert.ok(!getHomeyCapabilities(39).includes('powerview_status'));
  });

  it('adds a tilt control only where the shade tilts', () => {
    assert.ok(getHomeyCapabilities(51).includes('windowcoverings_tilt_set'));
    assert.ok(!getHomeyCapabilities(6).includes('windowcoverings_tilt_set'));
  });

  it('leaves the position control off a shade that only tilts', () => {
    const capabilities = getHomeyCapabilities(39);

    assert.ok(!capabilities.includes('windowcoverings_set'));
    assert.ok(capabilities.includes('windowcoverings_tilt_set'));
  });

  it('adds a second rail to a dual-rail shade', () => {
    assert.ok(getHomeyCapabilities(47).includes('powerview_secondary'));
    assert.ok(!getHomeyCapabilities(6).includes('powerview_secondary'));
  });

  it('only ever names capabilities the app declares', () => {
    // Read the manifest rather than restating it: a hand-kept list here would
    // agree with itself while the app shipped a capability it never declared,
    // which is a device that fails to add it at runtime.
    const manifest = require('../app.json');
    const declared = new Set([
      ...Object.keys(manifest.capabilities),
      'windowcoverings_set',
      'windowcoverings_state',
      'windowcoverings_tilt_set',
      'measure_battery',
    ]);

    for (const typeId of Object.keys(SHADE_TYPES)) {
      for (const capability of getHomeyCapabilities(Number(typeId))) {
        assert.ok(declared.has(capability), `type ${typeId} asks for unknown ${capability}`);
      }
    }
  });
});
