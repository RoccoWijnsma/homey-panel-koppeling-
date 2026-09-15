'use strict';

const { CLOSED_POSITION, KEEP_POSITION, OPEN_POSITION } = require('./const');

/**
 * Translation between Homey capability values and the shade's own axes.
 *
 * Homey and the shade agree on the common case - 0 is closed, 100 is open -
 * but several shade types invert or remap an axis, and dual-rail shades hang
 * two positions off one device. All of that lives here, so the transport in
 * `shade.js` only ever sees device-facing numbers and the device driver only
 * ever sees Homey-facing ones.
 *
 * Everything is a pure function of the last decoded advertisement, which is
 * the only reading there is: the shade broadcasts its position rather than
 * answering questions about it.
 */

/**
 * Point on the combined Duolite scale where the moving fabric changes over.
 * Below it the rear opaque fabric travels its full range, above it the front
 * sheer does.
 */
const DUOLITE_MIDPOINT = 50;

/**
 * @param {number} percent 0..100
 * @returns {number} 0..1, rounded to whole percentage points.
 */
function toHomey(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  return Math.round(clamped) / 100;
}

/**
 * @param {number} value 0..1
 * @returns {number} 0..100
 */
function toPercent(value) {
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

/**
 * Position for `windowcoverings_set`.
 *
 * @param {object|null} decoded Last decoded advertisement.
 * @param {import('./shade-types').ShadeCapabilities} caps
 * @returns {number|null} 0..1, or null when this shade has no lift axis or
 *   nothing has been heard from it yet.
 */
function readPosition(decoded, caps) {
  if (!decoded || caps.tiltOnly) return null;

  if (caps.isDuolite) {
    // Fold both fabrics onto one scale: the rear owns the lower half, the
    // front the upper.
    const front = decoded.position1;
    const rear = decoded.position2;
    if (front === null || rear === null) return null;
    const combined = front === CLOSED_POSITION
      ? Math.ceil(rear / 2)
      : Math.ceil(front / 2) + DUOLITE_MIDPOINT;
    return toHomey(combined);
  }

  if (caps.isTdbu) {
    // position2 drives the physical bottom rail, on Homey's own axis.
    return toHomey(decoded.position2);
  }

  if (caps.isTopDown) {
    return toHomey(OPEN_POSITION - decoded.position1);
  }

  return toHomey(decoded.position1);
}

/**
 * Position for `powerview_secondary` - the top rail of a dual-rail shade.
 *
 * position1 drives that rail on this firmware, and drives it inverted, so it
 * is turned back onto Homey's axis here.
 *
 * @param {object|null} decoded
 * @param {import('./shade-types').ShadeCapabilities} caps
 * @returns {number|null}
 */
function readSecondary(decoded, caps) {
  if (!decoded || !caps.isTdbu) return null;
  return toHomey(OPEN_POSITION - decoded.position1);
}

/**
 * @param {object|null} decoded
 * @param {import('./shade-types').ShadeCapabilities} caps
 * @returns {number|null}
 */
function readTilt(decoded, caps) {
  if (!decoded || !caps.hasTilt) return null;
  return toHomey(decoded.tilt);
}

/**
 * @param {object|null} decoded
 * @returns {'up'|'down'|'idle'}
 */
function readState(decoded) {
  if (!decoded) return 'idle';
  if (decoded.isOpening) return 'up';
  if (decoded.isClosing) return 'down';
  return 'idle';
}

/**
 * Build the move for a `windowcoverings_set` target.
 *
 * @param {number} target 0..1
 * @param {object|null} decoded Last decoded advertisement.
 * @param {import('./shade-types').ShadeCapabilities} caps
 * @returns {object|null} A move for {@link PowerViewShade#setPosition}, or
 *   null when the shade cannot be moved without a reading it does not have.
 */
function buildLiftMove(target, decoded, caps) {
  const percent = toPercent(target);

  if (caps.tiltOnly) return null;

  if (caps.isDuolite) {
    // The fabrics interlock: the front sheer must be retracted before the rear
    // can move, and the rear fully open before the front can. Every command
    // carries both axes, so the idle one is stated where the interlock needs
    // it rather than where it currently sits.
    if (percent > DUOLITE_MIDPOINT) {
      return { pos1: (percent - DUOLITE_MIDPOINT) * 2, pos2: OPEN_POSITION };
    }
    return { pos1: CLOSED_POSITION, pos2: percent * 2 };
  }

  if (caps.isTdbu) {
    // Stop the bottom rail rising past the top one. The top rail's Homey
    // position is 100 - raw position1, so that is what this clamps against.
    if (!decoded) return null;
    const limit = OPEN_POSITION - decoded.position1;
    // KEEP on pos1 lets a top-rail command that arrives at the same time
    // merge in, instead of this one overwriting the top rail's target.
    return { pos1: KEEP_POSITION, pos2: Math.min(percent, Math.round(limit)) };
  }

  if (caps.isTopDown) {
    return { pos1: OPEN_POSITION - percent };
  }

  return { pos1: percent };
}

/**
 * Build the move for a `powerview_secondary` target (dual-rail top rail).
 *
 * @param {number} target 0..1
 * @param {object|null} decoded
 * @param {import('./shade-types').ShadeCapabilities} caps
 * @returns {object|null}
 */
function buildSecondaryMove(target, decoded, caps) {
  if (!caps.isTdbu || !decoded) return null;

  // Stop the top rail being pulled down past the bottom one - a lower bound on
  // the target, not an upper one.
  const percent = Math.max(toPercent(target), Math.round(decoded.position2));
  return { pos1: OPEN_POSITION - percent };
}

/**
 * Build the move for a `windowcoverings_tilt_set` target.
 *
 * The lift axis has to be restated in every position command, and it is the
 * device's own reading that belongs on the wire - not the possibly inverted
 * view Homey shows. A shade with no lift axis states it closed instead, which
 * is where it always is.
 *
 * @param {number} target 0..1
 * @param {object|null} decoded
 * @param {import('./shade-types').ShadeCapabilities} caps
 * @returns {object|null} null when the shade has a lift axis but no reading of
 *   it yet, in which case the tilt is dropped rather than sent with a guess.
 */
function buildTiltMove(target, decoded, caps) {
  if (!caps.hasTilt) return null;
  const tilt = toPercent(target);

  if (caps.tiltOnly) {
    return { pos1: CLOSED_POSITION, tilt };
  }
  if (!decoded) return null;

  return { pos1: Math.round(decoded.position1), tilt };
}

module.exports = {
  DUOLITE_MIDPOINT,
  buildLiftMove,
  buildSecondaryMove,
  buildTiltMove,
  readPosition,
  readSecondary,
  readState,
  readTilt,
  toHomey,
  toPercent,
};
