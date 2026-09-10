'use strict';

/**
 * BLE UUID helpers.
 *
 * Homey reports UUIDs the way noble does: lowercase hex with no dashes, and
 * SIG-assigned UUIDs shortened to their 16-bit form ("fdc1" rather than
 * "0000fdc1-0000-1000-8000-00805f9b34fb"). The constants in this app are
 * written in full so they are recognisable, so every comparison goes through
 * here rather than assuming one form or the other.
 */

const BLUETOOTH_BASE_SUFFIX = '00001000800000805f9b34fb';

/**
 * Reduce a UUID to a single comparable form: lowercase, no dashes, and
 * shortened to 16 bits when it sits on the Bluetooth base UUID.
 *
 * @param {string} uuid
 * @returns {string}
 */
function normalize(uuid) {
  if (typeof uuid !== 'string') return '';
  const flat = uuid.toLowerCase().replace(/-/g, '');

  if (flat.length === 32 && flat.endsWith(BLUETOOTH_BASE_SUFFIX) && flat.startsWith('0000')) {
    return flat.slice(4, 8);
  }
  return flat;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean} Whether both name the same UUID, in whichever form.
 */
function equals(a, b) {
  return normalize(a) === normalize(b);
}

/**
 * Find an entry in a list of BLE objects by UUID, tolerating either form.
 *
 * @template {{uuid: string}} T
 * @param {T[]} items
 * @param {string} uuid
 * @returns {T|undefined}
 */
function findByUuid(items, uuid) {
  if (!Array.isArray(items)) return undefined;
  const wanted = normalize(uuid);
  return items.find((item) => item && normalize(item.uuid) === wanted);
}

module.exports = { equals, findByUuid, normalize };
