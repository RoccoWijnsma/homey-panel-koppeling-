'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { KEEP_POSITION } = require('../lib/const');
const { getCapabilities } = require('../lib/shade-types');
const {
  buildLiftMove,
  buildSecondaryMove,
  buildTiltMove,
  readPosition,
  readSecondary,
  readState,
  readTilt,
} = require('../lib/position');

/**
 * @param {object} [overrides]
 * @returns {object} A decoded advertisement with everything at rest.
 */
function advert(overrides = {}) {
  return {
    homeId: 0x1234,
    typeId: 6,
    position1: 0,
    position2: 0,
    position3: 0,
    tilt: 0,
    isOpening: false,
    isClosing: false,
    isCharging: false,
    batteryLevel: 100,
    resetMode: false,
    clockLost: false,
    ...overrides,
  };
}

const DUETTE = getCapabilities(6); // plain lift
const TOP_DOWN = getCapabilities(7); // inverted lift
const PLEATED_TDBU = getCapabilities(47); // two rails
const VENETIAN = getCapabilities(51); // lift and tilt
const PARKLAND = getCapabilities(39); // tilt only
const SILHOUETTE = getCapabilities(23); // tilt on closed
const DUOLITE = getCapabilities(65); // two fabrics

describe('a plain lift shade', () => {
  it('reports the device position unchanged, because both scales agree', () => {
    assert.equal(readPosition(advert({ position1: 0 }), DUETTE), 0, 'closed');
    assert.equal(readPosition(advert({ position1: 100 }), DUETTE), 1, 'open');
    assert.equal(readPosition(advert({ position1: 51.2 }), DUETTE), 0.51);
  });

  it('sends the target as-is', () => {
    assert.deepEqual(buildLiftMove(0.75, advert(), DUETTE), { pos1: 75 });
    assert.deepEqual(buildLiftMove(0, advert(), DUETTE), { pos1: 0 });
    assert.deepEqual(buildLiftMove(1, advert(), DUETTE), { pos1: 100 });
  });

  it('does not need a reading to move', () => {
    // Nothing has to be restated, so a shade Homey has not heard yet still
    // takes an open or close command.
    assert.deepEqual(buildLiftMove(1, null, DUETTE), { pos1: 100 });
  });

  it('has no tilt or second rail to report', () => {
    assert.equal(readTilt(advert({ tilt: 40 }), DUETTE), null);
    assert.equal(readSecondary(advert(), DUETTE), null);
  });
});

describe('a top-down shade', () => {
  it('inverts the device axis so 100% still means open', () => {
    assert.equal(readPosition(advert({ position1: 0 }), TOP_DOWN), 1);
    assert.equal(readPosition(advert({ position1: 100 }), TOP_DOWN), 0);
  });

  it('inverts the target back on the way out', () => {
    assert.deepEqual(buildLiftMove(0.75, advert(), TOP_DOWN), { pos1: 25 });
    assert.deepEqual(buildLiftMove(1, advert(), TOP_DOWN), { pos1: 0 });
  });

  it('survives a round trip', () => {
    const move = buildLiftMove(0.3, advert(), TOP_DOWN);
    assert.equal(readPosition(advert({ position1: move.pos1 }), TOP_DOWN), 0.3);
  });
});

describe('a dual-rail top-down/bottom-up shade', () => {
  it('reads the bottom rail off position 2 and the top rail off an inverted position 1', () => {
    const decoded = advert({ position1: 30, position2: 20 });

    assert.equal(readPosition(decoded, PLEATED_TDBU), 0.2, 'bottom rail');
    assert.equal(readSecondary(decoded, PLEATED_TDBU), 0.7, 'top rail');
  });

  it('drives the bottom rail through position 2 and leaves the top alone', () => {
    const move = buildLiftMove(0.4, advert({ position1: 30 }), PLEATED_TDBU);

    assert.equal(move.pos1, KEEP_POSITION, 'so a top-rail command can merge in');
    assert.equal(move.pos2, 40);
  });

  it('stops the bottom rail rising past the top one', () => {
    // Top rail at device 30 sits at 70% on Homey's scale, so that is the
    // highest the bottom rail may go.
    const move = buildLiftMove(1, advert({ position1: 30 }), PLEATED_TDBU);
    assert.equal(move.pos2, 70);
  });

  it('stops the top rail being pulled below the bottom one', () => {
    const move = buildSecondaryMove(0.1, advert({ position2: 40 }), PLEATED_TDBU);
    assert.equal(move.pos1, 60, 'clamped to the bottom rail, then inverted');
  });

  it('refuses to move either rail without a reading of the other', () => {
    // A guess here moves a rail the user did not ask about.
    assert.equal(buildLiftMove(0.5, null, PLEATED_TDBU), null);
    assert.equal(buildSecondaryMove(0.5, null, PLEATED_TDBU), null);
  });
});

describe('a shade that tilts', () => {
  it('reports tilt on Homey\'s scale', () => {
    assert.equal(readTilt(advert({ tilt: 45 }), VENETIAN), 0.45);
  });

  it('restates the lift axis, because every position command carries it', () => {
    const move = buildTiltMove(0.9, advert({ position1: 62 }), VENETIAN);
    assert.deepEqual(move, { pos1: 62, tilt: 90 });
  });

  it('drops the tilt rather than guessing where the lift axis is', () => {
    assert.equal(buildTiltMove(0.5, null, VENETIAN), null);
  });

  it('sends a tilt-on-closed shade its tilt without closing it first', () => {
    // The vanes only engage when closed, but that is the hardware's business;
    // driving the lift here would swallow the tilt the user asked for.
    const move = buildTiltMove(0.5, advert({ position1: 80 }), SILHOUETTE);
    assert.deepEqual(move, { pos1: 80, tilt: 50 });
  });
});

describe('a tilt-only shade', () => {
  it('has no lift position to report', () => {
    assert.equal(readPosition(advert({ position1: 40 }), PARKLAND), null);
  });

  it('states the lift axis closed, where it always is', () => {
    assert.deepEqual(buildTiltMove(0.25, advert(), PARKLAND), { pos1: 0, tilt: 25 });
  });

  it('needs no reading, so it works from the first command', () => {
    assert.deepEqual(buildTiltMove(0.25, null, PARKLAND), { pos1: 0, tilt: 25 });
  });

  it('cannot be lifted', () => {
    assert.equal(buildLiftMove(0.5, advert(), PARKLAND), null);
  });
});

describe('a Duolite shade', () => {
  it('folds both fabrics onto one scale', () => {
    // Below the midpoint the rear opaque fabric travels; above it the front
    // sheer does.
    assert.equal(readPosition(advert({ position1: 0, position2: 0 }), DUOLITE), 0);
    assert.equal(readPosition(advert({ position1: 0, position2: 100 }), DUOLITE), 0.5);
    assert.equal(readPosition(advert({ position1: 100, position2: 100 }), DUOLITE), 1);
  });

  it('drives the rear fabric in the lower half', () => {
    assert.deepEqual(buildLiftMove(0.25, advert(), DUOLITE), { pos1: 0, pos2: 50 });
  });

  it('drives the front fabric in the upper half, with the rear held open', () => {
    // The fabrics interlock, so the idle axis is stated where the interlock
    // needs it rather than where it currently sits.
    assert.deepEqual(buildLiftMove(0.75, advert(), DUOLITE), { pos1: 50, pos2: 100 });
  });
});

describe('readState', () => {
  it('follows the motion flags', () => {
    assert.equal(readState(advert({ isOpening: true })), 'up');
    assert.equal(readState(advert({ isClosing: true })), 'down');
    assert.equal(readState(advert()), 'idle');
    assert.equal(readState(null), 'idle');
  });
});
