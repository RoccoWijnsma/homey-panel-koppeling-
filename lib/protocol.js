'use strict';

const crypto = require('crypto');

const {
  ACK_OPCODE_MASK,
  MIN_KEYSTREAM_LENGTH,
  ADVERTISEMENT_POSITION_SCALE,
  ADVERTISEMENT_RECORD_LENGTH,
  CMD,
  HOME_KEY_LENGTH,
  KEEP_POSITION,
  MANUFACTURER_ID,
  POSITION_WIRE_SCALE,
  POWER_LEVELS,
  POWER_STATUS_LENGTH,
  POWER_STATUS_OK,
  POWER_TYPE_BATTERY,
  POWER_TYPE_HARDWIRED,
  SCENE_PAYLOAD_SUFFIX,
} = require('./const');

/**
 * Framing, encryption and advertisement decoding for the PowerView BLE
 * protocol. Everything in here is pure: no I/O, no Homey objects. That keeps
 * the byte-level work testable without a shade in the room.
 */

// --- home key ---------------------------------------------------------------

/**
 * Parse a user-supplied home key into the 16 bytes AES-128 needs.
 *
 * Accepts the two shapes people actually paste: bare hex, and the
 * `\xAB\xCD...` escape form the shade emulator prints. Separators are ignored
 * so a key copied with spaces or colons still works.
 *
 * @param {string|Buffer|null|undefined} input
 * @returns {Buffer|null} The key, or null if there is no usable key in `input`.
 */
function parseHomeKey(input) {
  if (!input) return null;
  if (Buffer.isBuffer(input)) {
    return input.length === HOME_KEY_LENGTH ? Buffer.from(input) : null;
  }
  if (typeof input !== 'string') return null;

  const hex = input
    .trim()
    .toLowerCase()
    .replace(/\\x/g, '')
    .replace(/0x/g, '')
    .replace(/[\s:-]/g, '');

  if (hex.length !== HOME_KEY_LENGTH * 2) return null;
  if (!/^[0-9a-f]+$/.test(hex)) return null;

  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt or decrypt a frame with the home key.
 *
 * AES-128-CTR with an all-zero counter, restarted for every message - so the
 * same keystream covers each frame and one function serves both directions.
 * That is what the shade does; it is not a choice this app gets to make.
 *
 * @param {Buffer} data
 * @param {Buffer} homeKey 16 bytes.
 * @returns {Buffer}
 */
function transformFrame(data, homeKey) {
  if (!Buffer.isBuffer(homeKey) || homeKey.length !== HOME_KEY_LENGTH) {
    throw new TypeError(`Home key must be ${HOME_KEY_LENGTH} bytes`);
  }
  const cipher = crypto.createCipheriv('aes-128-ctr', homeKey, Buffer.alloc(16));
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * Parse a keystream recovered from the app's own BLE log.
 *
 * An alternative to the home key, for installs where the key cannot be had.
 * The shades restart their counter at zero for every frame, so one keystream
 * covers every message - which is a weakness in their encryption, and the only
 * reason this works.
 *
 * @param {string|Buffer|null|undefined} input
 * @returns {Buffer|null} The keystream, or null if there is no usable one.
 */
function parseKeystream(input) {
  if (!input) return null;

  let bytes;
  if (Buffer.isBuffer(input)) {
    bytes = Buffer.from(input);
  } else if (typeof input === 'string') {
    const hex = input.trim().toLowerCase().replace(/\\x/g, '').replace(/[\s:-]/g, '');
    if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) return null;
    bytes = Buffer.from(hex, 'hex');
  } else {
    return null;
  }

  // Shorter than a position command is not enough to drive anything.
  if (bytes.length < MIN_KEYSTREAM_LENGTH) return null;
  return bytes;
}

/**
 * XOR a frame against the keystream.
 *
 * @param {Buffer} data
 * @param {Buffer} keystream
 * @returns {Buffer}
 * @throws {RangeError} When the frame runs past what the keystream covers -
 *   which would otherwise put a half-encrypted command on the wire.
 */
function xorKeystream(data, keystream) {
  if (data.length > keystream.length) {
    throw new RangeError(
      `Keystream covers ${keystream.length} bytes but this frame is ${data.length}`,
    );
  }
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] ^ keystream[i];
  }
  return out;
}

// --- framing ----------------------------------------------------------------

/**
 * Build a request frame: opcode (LE16), sequence number, payload length, payload.
 *
 * @param {number} opcode One of {@link CMD}.
 * @param {number} sequence 1..255; the shade echoes it back in its reply.
 * @param {Buffer} [payload]
 * @returns {Buffer}
 */
function buildFrame(opcode, sequence, payload = Buffer.alloc(0)) {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 0xff) {
    throw new RangeError(`Sequence must be 1..255, got ${sequence}`);
  }
  if (payload.length > 0xff) {
    throw new RangeError(`Payload too long: ${payload.length} bytes`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt16LE(opcode, 0);
  header.writeUInt8(sequence, 2);
  header.writeUInt8(payload.length, 3);
  return Buffer.concat([header, payload]);
}

/**
 * Parse a reply frame. Returns null when the buffer is too short to be one.
 *
 * @param {Buffer} data
 * @returns {{opcode: number, sequence: number, length: number, payload: Buffer}|null}
 */
function parseFrame(data) {
  if (!Buffer.isBuffer(data) || data.length < 4) return null;
  const length = data.readUInt8(3);
  return {
    opcode: data.readUInt16LE(0),
    sequence: data.readUInt8(2),
    length,
    payload: data.subarray(4, 4 + length),
  };
}

/**
 * Whether a parsed reply belongs to the request that was sent.
 *
 * @param {ReturnType<typeof parseFrame>} frame
 * @param {number} opcode The opcode that was sent.
 * @param {number} sequence The sequence number that was sent.
 * @returns {boolean}
 */
function frameMatches(frame, opcode, sequence) {
  if (!frame) return false;
  return frame.opcode === (opcode & ACK_OPCODE_MASK) && frame.sequence === sequence;
}

/**
 * Read the status byte out of an acknowledgement reply.
 *
 * Known non-zero statuses are 0x04 (invalid length) and 0x80 (invalid field
 * value).
 *
 * @param {ReturnType<typeof parseFrame>} frame
 * @returns {number|null} 0 on success, the status code on refusal, or null if
 *   the reply is not shaped like an acknowledgement at all.
 */
function readAckStatus(frame) {
  if (!frame || frame.length !== 1 || frame.payload.length !== 1) return null;
  return frame.payload.readUInt8(0);
}

// --- command payloads -------------------------------------------------------

/**
 * Scale one lift axis for the wire.
 *
 * KEEP_POSITION means "leave this axis alone" and is sent verbatim, so it must
 * skip the fixed-point scaling a real position gets. Without that a dual-rail
 * command cannot leave the other rail where it is.
 *
 * @param {number} position 0..100, or KEEP_POSITION.
 * @returns {number}
 */
function encodeLiftAxis(position) {
  if (position === KEEP_POSITION) return KEEP_POSITION;
  const clamped = Math.max(0, Math.min(100, Math.round(position)));
  return clamped * POSITION_WIRE_SCALE;
}

/**
 * Build a SET_POSITION payload: pos1, pos2, pos3, tilt (all LE16), velocity (u8).
 *
 * pos1 and pos2 are lift rails and get fixed-point scaling; pos3 and tilt are
 * sent as plain 0..100. Any axis left at its default is not moved.
 *
 * @param {object} move
 * @param {number} [move.pos1] Primary rail, 0..100.
 * @param {number} [move.pos2] Secondary rail, 0..100.
 * @param {number} [move.pos3] Third axis, 0..100.
 * @param {number} [move.tilt] Tilt, 0..100.
 * @param {number} [move.velocity] 0 to let the shade choose, else 10..100.
 * @returns {Buffer}
 */
function buildSetPositionPayload({
  pos1 = KEEP_POSITION,
  pos2 = KEEP_POSITION,
  pos3 = KEEP_POSITION,
  tilt = KEEP_POSITION,
  velocity = 0,
} = {}) {
  const payload = Buffer.alloc(9);
  payload.writeUInt16LE(encodeLiftAxis(pos1), 0);
  payload.writeUInt16LE(encodeLiftAxis(pos2), 2);
  payload.writeUInt16LE(pos3 === KEEP_POSITION ? KEEP_POSITION : clampPercent(pos3), 4);
  payload.writeUInt16LE(tilt === KEEP_POSITION ? KEEP_POSITION : clampPercent(tilt), 6);
  payload.writeUInt8(Math.max(0, Math.min(100, Math.round(velocity))), 8);
  return payload;
}

/**
 * Merge two SET_POSITION payloads axis by axis, keeping the pending value
 * wherever the newer command says KEEP.
 *
 * This is what lets a top-rail move and a bottom-rail move that arrive back to
 * back become one command driving both rails, instead of the second replacing
 * the first and dropping a rail.
 *
 * @param {Buffer} pending
 * @param {Buffer} next
 * @returns {Buffer}
 */
function mergeSetPositionPayloads(pending, next) {
  if (pending.length < 9 || next.length < 9) return next;
  const merged = Buffer.from(next);
  for (const offset of [0, 2, 4, 6]) {
    if (next.readUInt16LE(offset) === KEEP_POSITION) {
      merged.writeUInt16LE(pending.readUInt16LE(offset), offset);
    }
  }
  return merged;
}

/**
 * @param {number} index Scene slot on the shade.
 * @returns {Buffer}
 */
function buildScenePayload(index) {
  return Buffer.from([index & 0xff, SCENE_PAYLOAD_SUFFIX]);
}

/**
 * Build a SET_TIME payload: year (LE16), month, day, hour, minute, second,
 * ISO weekday.
 *
 * A shade that loses power stops its clock and its stored schedules stay
 * dormant until something tells it the time. The weekday is ISO 8601
 * (Monday = 1 .. Sunday = 7); the shade bounds-checks the byte and refuses
 * anything outside that, so a zero-based weekday would be rejected on Mondays.
 *
 * @param {Date} date
 * @returns {Buffer}
 */
function buildTimePayload(date) {
  const payload = Buffer.alloc(8);
  payload.writeUInt16LE(date.getFullYear(), 0);
  payload.writeUInt8(date.getMonth() + 1, 2);
  payload.writeUInt8(date.getDate(), 3);
  payload.writeUInt8(date.getHours(), 4);
  payload.writeUInt8(date.getMinutes(), 5);
  payload.writeUInt8(date.getSeconds(), 6);
  payload.writeUInt8(date.getDay() === 0 ? 7 : date.getDay(), 7);
  return payload;
}

// --- advertisement ----------------------------------------------------------

/**
 * Strip the Bluetooth SIG company identifier from an advertisement's
 * manufacturer data, and reject anything that is not a PowerView shade.
 *
 * Homey hands over the raw record including the two-byte company ID, the way
 * noble does, so the company ID is always there to check - and checking it is
 * the whole test. This once also accepted a bare record of the right length on
 * the theory that a caller might have stripped the prefix already. No caller
 * ever did, and the cost was real: any device whose manufacturer data happens
 * to run nine bytes was read as a shade. Apple's beacons are nine bytes, so a
 * house full of iPhones and AirPods showed up as shades in home 76 - which is
 * Apple's company ID, 0x004C, read as a home ID - with tilts of 148% and 197%.
 *
 * @param {Buffer|null|undefined} manufacturerData
 * @returns {Buffer|null} The 9-byte PowerView record, or null if this
 *   advertisement is from anything else.
 */
function extractShadeRecord(manufacturerData) {
  if (!Buffer.isBuffer(manufacturerData)) return null;
  if (manufacturerData.length !== ADVERTISEMENT_RECORD_LENGTH + 2) return null;
  if (manufacturerData.readUInt16LE(0) !== MANUFACTURER_ID) return null;

  return manufacturerData.subarray(2);
}

/**
 * Decode the 9-byte advertisement record a shade broadcasts continuously.
 *
 * This is the only source of position and battery readings - the shade is not
 * polled for them - so everything the app shows between commands comes from
 * here.
 *
 * Byte layout:
 *   0-1  home ID (LE16); zero means the shade is not bound to a home
 *   2    shade type ID
 *   3    bits 0-1 motion flags, bits 2-7 low bits of position 1
 *   4    bits 0-3 high bits of position 1, bits 4-7 low bits of position 2
 *   5    high bits of position 2
 *   6    position 3
 *   7    tilt
 *   8    bit 0 reset mode, bit 1 clock lost, bits 6-7 battery level
 *
 * @param {Buffer} record A 9-byte record from {@link extractShadeRecord}.
 * @returns {object|null} Decoded fields, or null if the record is the wrong size.
 */
function decodeAdvertisement(record) {
  if (!Buffer.isBuffer(record) || record.length !== ADVERTISEMENT_RECORD_LENGTH) {
    return null;
  }

  // Read the motion flags before masking anything out of byte 3.
  const flags = record[3] & 0x3;

  // Position 1 is 10 bits split across bytes 3 and 4. Mask off the upper
  // nibble of byte 4 first, or a non-zero second rail contaminates the reading.
  const rawPosition1 = ((record[4] & 0x0f) << 6) | ((record[3] >> 2) & 0x3f);

  // Position 2 shares byte 4's upper nibble with byte 5. The extra two bits of
  // width are dropped by the shift, matching position 1's 10-bit scale - this
  // is inferred by symmetry rather than confirmed against dual-rail hardware.
  const rawPosition2 = (record[5] << 4) + (record[4] >> 4);

  return {
    homeId: record.readUInt16LE(0),
    typeId: record[2],
    position1: rawPosition1 / ADVERTISEMENT_POSITION_SCALE,
    position2: (rawPosition2 >> 2) / ADVERTISEMENT_POSITION_SCALE,
    position3: record[6],
    tilt: record[7],
    isOpening: flags === 0x2,
    isClosing: flags === 0x1,
    isCharging: flags === 0x3,
    batteryLevel: POWER_LEVELS[record[8] >> 6],
    resetMode: Boolean(record[8] & 0x1),
    clockLost: Boolean(record[8] & 0x2),
  };
}

/**
 * Whether a shade's traffic is encrypted, and so needs the home key.
 *
 * A shade that has been added to a home in the PowerView app carries that
 * home's ID in its advertisement and will ignore plaintext commands. One that
 * has never been added advertises home ID 0 and takes commands unencrypted.
 *
 * @param {{homeId: number}} decoded
 * @returns {boolean}
 */
function isEncrypted(decoded) {
  return Boolean(decoded && decoded.homeId);
}

/**
 * Decode a POWER_STATUS reply.
 *
 * @param {Buffer} payload
 * @returns {{powerType: number, isHardwired: boolean, isBattery: boolean}|null}
 *   null when the shade said nothing usable - a short reply, or the non-zero
 *   lead byte that type 10 shades answer with. Treat null as unknown rather
 *   than as any particular power source.
 */
function decodePowerStatus(payload) {
  if (!Buffer.isBuffer(payload) || payload.length !== POWER_STATUS_LENGTH) return null;
  if (payload[0] !== POWER_STATUS_OK) return null;

  const powerType = payload[1];
  return {
    powerType,
    isHardwired: POWER_TYPE_HARDWIRED.has(powerType),
    isBattery: POWER_TYPE_BATTERY.has(powerType),
  };
}

// --- helpers ----------------------------------------------------------------

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

module.exports = {
  buildFrame,
  parseKeystream,
  xorKeystream,
  buildScenePayload,
  buildSetPositionPayload,
  buildTimePayload,
  clampPercent,
  decodeAdvertisement,
  decodePowerStatus,
  encodeLiftAxis,
  extractShadeRecord,
  frameMatches,
  isEncrypted,
  mergeSetPositionPayloads,
  parseFrame,
  parseHomeKey,
  readAckStatus,
  transformFrame,
};
