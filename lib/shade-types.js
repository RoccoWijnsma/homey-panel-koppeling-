'use strict';

/**
 * PowerView shade type IDs, their product names, and what each type can do.
 *
 * The type ID arrives in byte 2 of every advertisement, so a shade tells us
 * its own capabilities before we ever connect. The table mirrors the classes
 * aiopvapi registers each type under - the library behind Home Assistant's
 * gateway-based integration - so a type behaves the same here as it does over
 * the gateway API.
 */

const SHADE_TYPES = {
  // Lift only.
  1: 'Designer Roller',
  4: 'Roman',
  5: 'Bottom Up',
  6: 'Duette',
  10: 'Duette and Applause SkyLift',
  19: 'Provenance Woven Wood',
  26: 'Skyline Panel, Left Stack',
  27: 'Skyline Panel, Right Stack',
  28: 'Skyline Panel, Split Stack',
  31: 'Vignette',
  32: 'Vignette',
  42: 'M25T Roller Blind',
  49: 'AC Roller',
  52: 'Banded Shades',
  53: 'Sonnette',
  57: 'Carole Roman Shades',
  69: 'Curtain, Left Stack',
  70: 'Curtain, Right Stack',
  71: 'Curtain, Split Stack',
  84: 'Vignette',
  // Single rail, inverted lift axis.
  7: 'Top Down',
  // Two independent rails.
  8: 'Duette, Top Down Bottom Up',
  9: 'Duette DuoLite, Top Down Bottom Up',
  33: 'Duette Architella, Top Down Bottom Up',
  47: 'Pleated, Top Down Bottom Up',
  // Tilt only, no lift movement.
  39: 'Parkland',
  40: 'Everwood Alternative Wood Blinds',
  66: 'Palm Beach Shutters',
  // Tilt available only at the closed position.
  18: 'Pirouette',
  23: 'Silhouette',
  43: 'Facette',
  44: 'Twist',
  72: 'Silhouette',
  // Lift and tilt, tilt available anywhere.
  51: 'Venetian, Tilt Anywhere',
  54: 'Vertical Slats, Left Stack',
  55: 'Vertical Slats, Right Stack',
  56: 'Vertical Slats, Split Stack',
  62: 'Venetian, Tilt Anywhere',
  103: 'Designer Banded, Tilt Anywhere',
  // Two overlapping fabrics on one rail.
  38: 'Silhouette Duolite',
  65: 'Vignette Duolite',
  79: 'Duolite Lift',
  95: 'Aura Illuminated, Roller',
};

/**
 * @typedef {object} ShadeCapabilities
 * @property {boolean} hasTilt        Shade has a tilt axis.
 * @property {boolean} tiltOnly       Tilt is the only axis; lift does nothing.
 * @property {boolean} tiltOnClosed   Tilt only works at the fully closed position.
 * @property {boolean} isTopDown      Lift axis is inverted (device 0 = open).
 * @property {boolean} isTdbu         Two independent rails (top-down/bottom-up).
 * @property {boolean} isDuolite      Two overlapping fabrics on one rail.
 */

/** @type {ShadeCapabilities} */
const DEFAULT_CAPABILITIES = Object.freeze({
  hasTilt: false,
  tiltOnly: false,
  tiltOnClosed: false,
  isTopDown: false,
  isTdbu: false,
  isDuolite: false,
});

function caps(overrides) {
  return Object.freeze({ ...DEFAULT_CAPABILITIES, ...overrides });
}

const SHADE_CAPABILITIES = {
  // Lift and tilt, tilt available anywhere.
  51: caps({ hasTilt: true }),
  54: caps({ hasTilt: true }),
  55: caps({ hasTilt: true }),
  56: caps({ hasTilt: true }),
  62: caps({ hasTilt: true }),
  103: caps({ hasTilt: true }),
  // Tilt only.
  39: caps({ hasTilt: true, tiltOnly: true }),
  40: caps({ hasTilt: true, tiltOnly: true }),
  66: caps({ hasTilt: true, tiltOnly: true }),
  // Tilt on closed.
  18: caps({ hasTilt: true, tiltOnClosed: true }),
  23: caps({ hasTilt: true, tiltOnClosed: true }),
  43: caps({ hasTilt: true, tiltOnClosed: true }),
  44: caps({ hasTilt: true, tiltOnClosed: true }),
  72: caps({ hasTilt: true, tiltOnClosed: true }),
  // Inverted single rail. Type 10 (SkyLift) is deliberately absent despite
  // its name: aiopvapi registers it as a plain bottom-up shade.
  7: caps({ isTopDown: true }),
  // Two rails. Type 9 is named DuoLite but aiopvapi registers it as plain
  // TDBU, and the two-rail path is the one confirmed on hardware.
  8: caps({ isTdbu: true }),
  9: caps({ isTdbu: true }),
  33: caps({ isTdbu: true }),
  47: caps({ isTdbu: true }),
  // Duolite. Type 38 also tilts.
  38: caps({ hasTilt: true, isDuolite: true }),
  65: caps({ isDuolite: true }),
  79: caps({ isDuolite: true }),
  95: caps({ isDuolite: true }),
};

/**
 * @param {number|null|undefined} typeId
 * @returns {ShadeCapabilities} Capabilities for the type, or plain lift-only
 *   for an unknown one - which is what the gateway API also falls back to.
 */
function getCapabilities(typeId) {
  if (typeId === null || typeId === undefined) return DEFAULT_CAPABILITIES;
  return SHADE_CAPABILITIES[typeId] || DEFAULT_CAPABILITIES;
}

/**
 * @param {number|null|undefined} typeId
 * @returns {string} Product name, or a generic label for an unknown type.
 */
function getTypeName(typeId) {
  if (typeId === null || typeId === undefined) return 'PowerView Shade';
  return SHADE_TYPES[typeId] || `PowerView Shade (type ${typeId})`;
}

/**
 * Homey capabilities a shade of this type should be created with.
 *
 * @param {number|null|undefined} typeId
 * @returns {string[]}
 */
function getHomeyCapabilities(typeId) {
  const capabilities = getCapabilities(typeId);
  const result = [];

  if (!capabilities.tiltOnly) {
    result.push('windowcoverings_set');
  }
  if (capabilities.hasTilt) {
    result.push('windowcoverings_tilt_set');
  }
  result.push('windowcoverings_state');
  if (capabilities.isTdbu) {
    result.push('powerview_secondary');
  }
  result.push('measure_battery');

  return result;
}

module.exports = {
  DEFAULT_CAPABILITIES,
  SHADE_CAPABILITIES,
  SHADE_TYPES,
  getCapabilities,
  getHomeyCapabilities,
  getTypeName,
};
