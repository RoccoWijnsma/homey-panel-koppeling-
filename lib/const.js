'use strict';

/**
 * Protocol constants for Hunter Douglas / Luxaflex PowerView Gen 3 shades
 * over Bluetooth LE.
 *
 * The wire format is not published by the vendor. Everything here is taken
 * from the reverse-engineered Home Assistant integration at
 * https://github.com/safepay/hdpv_ble, which documents each field against
 * observations on real hardware. Where that project marks something as
 * inferred rather than confirmed, the comment says so here too.
 */

/** Service that carries the shade control characteristic (16-bit 0xFDC1). */
const SERVICE_UUID = '0000fdc1-0000-1000-8000-00805f9b34fb';

/** Standard Device Information service, for model/firmware strings. */
const DEVICE_INFO_SERVICE_UUID = '0000180a-0000-1000-8000-00805f9b34fb';

/**
 * The single characteristic used for control. Commands are written to it and
 * replies arrive as notifications on the same characteristic.
 */
const CONTROL_CHARACTERISTIC_UUID = 'cafe1001-c0ff-ee01-8000-a110ca7ab1e0';

/** Device Information characteristics, by the field they hold. */
const DEVICE_INFO_CHARACTERISTICS = {
  manufacturer: '00002a29-0000-1000-8000-00805f9b34fb',
  model: '00002a24-0000-1000-8000-00805f9b34fb',
  serialNumber: '00002a25-0000-1000-8000-00805f9b34fb',
  hardwareRevision: '00002a27-0000-1000-8000-00805f9b34fb',
  firmwareRevision: '00002a26-0000-1000-8000-00805f9b34fb',
  softwareRevision: '00002a28-0000-1000-8000-00805f9b34fb',
};

/** Bluetooth SIG company identifier the shades advertise under (0x0819). */
const MANUFACTURER_ID = 2073;

/** Length of the V2 manufacturer-data record every PowerView shade sends. */
const ADVERTISEMENT_RECORD_LENGTH = 9;

/** Command opcodes, written little-endian as the first two frame bytes. */
const CMD = {
  SET_POSITION: 0x01f7,
  STOP: 0xb8f7,
  ACTIVATE_SCENE: 0xbaf7,
  IDENTIFY: 0x11f7,
  POWER_STATUS: 0xdeff,
  SET_TIME: 0x77ff,
  SET_SOLAR: 0x87ff,
};

/**
 * A reply echoes the opcode with bit 4 cleared, so acknowledgements are
 * matched against `opcode & ACK_OPCODE_MASK` rather than the opcode itself.
 */
const ACK_OPCODE_MASK = 0xffef;

/**
 * Sentinel meaning "leave this axis where it is". It is sent verbatim, which
 * for the two lift rails means skipping the x100 fixed-point scaling a real
 * position would get.
 */
const KEEP_POSITION = 0x8000;

/** Lift positions are sent as percent x 100, so 0..10000 over the wire. */
const POSITION_WIRE_SCALE = 100;

/**
 * Lift positions in the advertisement are 10-bit percent x 10, so the decoder
 * divides by this to get a 0..100 percentage.
 */
const ADVERTISEMENT_POSITION_SCALE = 10;

const OPEN_POSITION = 100;
const CLOSED_POSITION = 0;

/**
 * Velocity is a linear percentage of full speed. Below this floor the shade
 * reads the value as "no velocity given" and runs at full speed, so callers
 * asking for 1..9 get snapped up to 10 rather than silently getting 100.
 */
const MIN_VELOCITY = 10;

/** "No velocity given" - the shade picks its own speed. */
const DEFAULT_VELOCITY = 0;

/** Scene indices the shade stores for its own open/close buttons. */
const SCENE_OPEN = 2;
const SCENE_CLOSE = 3;

/** Second byte of an ACTIVATE_SCENE payload; purpose unknown, always 0xA2. */
const SCENE_PAYLOAD_SUFFIX = 0xa2;

/** Battery level reported in the top two bits of advertisement byte 8. */
const POWER_LEVELS = {
  3: 100, // 100%..51% remaining (also what hardwired shades report)
  2: 50, //   50%..21% remaining
  1: 20, //   20% or less remaining
  0: 0, //    no power remaining
};

/** Power-type codes, on the numbering the G3 gateway reports as `powerType`. */
const POWER_TYPE_HARDWIRED = new Set([1, 12]);
const POWER_TYPE_BATTERY = new Set([0, 2, 11]);

/** Length of a POWER_STATUS reply payload, and the status byte that means OK. */
const POWER_STATUS_LENGTH = 8;
const POWER_STATUS_OK = 0;

/** Home key length in bytes; AES-128 takes exactly this. */
const HOME_KEY_LENGTH = 16;

/**
 * Shortest useful keystream: a position command is 13 bytes, and anything
 * that cannot cover one cannot move a shade.
 */
const MIN_KEYSTREAM_LENGTH = 13;

module.exports = {
  ACK_OPCODE_MASK,
  ADVERTISEMENT_POSITION_SCALE,
  ADVERTISEMENT_RECORD_LENGTH,
  CLOSED_POSITION,
  CMD,
  CONTROL_CHARACTERISTIC_UUID,
  DEFAULT_VELOCITY,
  DEVICE_INFO_CHARACTERISTICS,
  DEVICE_INFO_SERVICE_UUID,
  HOME_KEY_LENGTH,
  KEEP_POSITION,
  MANUFACTURER_ID,
  MIN_KEYSTREAM_LENGTH,
  MIN_VELOCITY,
  OPEN_POSITION,
  POSITION_WIRE_SCALE,
  POWER_LEVELS,
  POWER_STATUS_LENGTH,
  POWER_STATUS_OK,
  POWER_TYPE_BATTERY,
  POWER_TYPE_HARDWIRED,
  SCENE_CLOSE,
  SCENE_OPEN,
  SCENE_PAYLOAD_SUFFIX,
  SERVICE_UUID,
};
