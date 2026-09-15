'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { ADVERTISEMENT_RECORD_LENGTH, CMD, KEEP_POSITION } = require('../lib/const');
const {
  buildFrame,
  buildScenePayload,
  buildSetPositionPayload,
  buildTimePayload,
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
} = require('../lib/protocol');

const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');

describe('parseHomeKey', () => {
  it('accepts bare hex', () => {
    assert.deepEqual(parseHomeKey('0123456789abcdef0123456789abcdef'), KEY);
  });

  it('accepts the escape form the shade emulator prints', () => {
    const escaped = [...KEY].map((b) => `\\x${b.toString(16).padStart(2, '0')}`).join('');
    assert.deepEqual(parseHomeKey(escaped), KEY);
  });

  it('ignores separators people paste along with the key', () => {
    assert.deepEqual(parseHomeKey('01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef'), KEY);
    assert.deepEqual(parseHomeKey('0123 4567 89AB CDEF 0123 4567 89AB CDEF'), KEY);
  });

  it('rejects anything that is not 16 bytes of hex', () => {
    assert.equal(parseHomeKey(''), null);
    assert.equal(parseHomeKey(null), null);
    assert.equal(parseHomeKey('0123456789abcdef'), null, 'half a key');
    assert.equal(parseHomeKey('0123456789abcdef0123456789abcdeg'), null, 'not hex');
    assert.equal(parseHomeKey(Buffer.alloc(8)), null, 'short buffer');
  });

  it('passes a 16-byte buffer straight through', () => {
    assert.deepEqual(parseHomeKey(KEY), KEY);
  });
});

describe('transformFrame', () => {
  it('is its own inverse, because the cipher is CTR', () => {
    const plain = Buffer.from('f7010109881300800080008000', 'hex');
    const encrypted = transformFrame(plain, KEY);

    assert.notDeepEqual(encrypted, plain);
    assert.deepEqual(transformFrame(encrypted, KEY), plain);
  });

  it('restarts the keystream for every frame', () => {
    // The shade decrypts each frame independently, so two identical frames must
    // encrypt identically - the counter does not carry across messages.
    const frame = Buffer.from('deadbeef', 'hex');
    assert.deepEqual(transformFrame(frame, KEY), transformFrame(frame, KEY));
  });

  it('refuses a key of the wrong length', () => {
    assert.throws(() => transformFrame(Buffer.alloc(4), Buffer.alloc(8)), TypeError);
  });
});

describe('buildFrame', () => {
  it('writes the opcode little-endian, then sequence and length', () => {
    const frame = buildFrame(CMD.SET_POSITION, 7, Buffer.from([0xaa, 0xbb]));
    assert.deepEqual(frame, Buffer.from([0xf7, 0x01, 0x07, 0x02, 0xaa, 0xbb]));
  });

  it('handles an empty payload', () => {
    assert.deepEqual(buildFrame(CMD.STOP, 1), Buffer.from([0xf7, 0xb8, 0x01, 0x00]));
  });

  it('refuses a sequence number that will not fit in its byte', () => {
    assert.throws(() => buildFrame(CMD.STOP, 0), RangeError);
    assert.throws(() => buildFrame(CMD.STOP, 256), RangeError);
  });
});

describe('parseFrame and frameMatches', () => {
  it('round-trips a frame', () => {
    const frame = parseFrame(buildFrame(CMD.IDENTIFY, 3, Buffer.from([0x05])));
    assert.equal(frame.opcode, CMD.IDENTIFY);
    assert.equal(frame.sequence, 3);
    assert.deepEqual(frame.payload, Buffer.from([0x05]));
  });

  it('returns null for anything too short to be a frame', () => {
    assert.equal(parseFrame(Buffer.from([1, 2, 3])), null);
    assert.equal(parseFrame(null), null);
  });

  it('matches a reply that echoes the opcode with bit 4 cleared', () => {
    // SET_POSITION is 0x01F7; the shade answers 0x01E7.
    const reply = parseFrame(Buffer.from([0xe7, 0x01, 0x09, 0x01, 0x00]));
    assert.equal(frameMatches(reply, CMD.SET_POSITION, 9), true);
  });

  it('rejects a reply to a different command or sequence', () => {
    const reply = parseFrame(Buffer.from([0xe7, 0x01, 0x09, 0x01, 0x00]));
    assert.equal(frameMatches(reply, CMD.STOP, 9), false);
    assert.equal(frameMatches(reply, CMD.SET_POSITION, 8), false);
    assert.equal(frameMatches(null, CMD.SET_POSITION, 9), false);
  });
});

describe('readAckStatus', () => {
  it('reads the status byte out of a one-byte acknowledgement', () => {
    assert.equal(readAckStatus(parseFrame(Buffer.from([0xe7, 0x01, 1, 1, 0x00]))), 0);
    assert.equal(readAckStatus(parseFrame(Buffer.from([0xe7, 0x01, 1, 1, 0x80]))), 0x80);
  });

  it('returns null when the reply is not shaped like an acknowledgement', () => {
    assert.equal(readAckStatus(parseFrame(Buffer.from([0xe7, 0x01, 1, 2, 0x00, 0x00]))), null);
    assert.equal(readAckStatus(null), null);
  });
});

describe('encodeLiftAxis', () => {
  it('scales a percentage into the wire\'s fixed point', () => {
    assert.equal(encodeLiftAxis(0), 0);
    assert.equal(encodeLiftAxis(50), 5000);
    assert.equal(encodeLiftAxis(100), 10000);
  });

  it('passes the keep sentinel through unscaled', () => {
    // Scaling it would turn "leave this rail alone" into a move.
    assert.equal(encodeLiftAxis(KEEP_POSITION), KEEP_POSITION);
  });

  it('clamps out-of-range percentages', () => {
    assert.equal(encodeLiftAxis(-10), 0);
    assert.equal(encodeLiftAxis(140), 10000);
  });
});

describe('buildSetPositionPayload', () => {
  it('lays out four axes and a velocity byte', () => {
    const payload = buildSetPositionPayload({ pos1: 25, pos2: 50, pos3: 10, tilt: 90, velocity: 40 });

    assert.equal(payload.length, 9);
    assert.equal(payload.readUInt16LE(0), 2500, 'pos1 is percent x 100');
    assert.equal(payload.readUInt16LE(2), 5000, 'pos2 is percent x 100');
    assert.equal(payload.readUInt16LE(4), 10, 'pos3 is a plain percentage');
    assert.equal(payload.readUInt16LE(6), 90, 'tilt is a plain percentage');
    assert.equal(payload.readUInt8(8), 40);
  });

  it('leaves every unnamed axis alone', () => {
    const payload = buildSetPositionPayload({ tilt: 20 });

    assert.equal(payload.readUInt16LE(0), KEEP_POSITION);
    assert.equal(payload.readUInt16LE(2), KEEP_POSITION);
    assert.equal(payload.readUInt16LE(4), KEEP_POSITION);
    assert.equal(payload.readUInt16LE(6), 20);
    assert.equal(payload.readUInt8(8), 0, 'no velocity means the shade picks one');
  });
});

describe('mergeSetPositionPayloads', () => {
  it('lets two rails moving at once become one command', () => {
    const top = buildSetPositionPayload({ pos1: 10 });
    const bottom = buildSetPositionPayload({ pos2: 80 });
    const merged = mergeSetPositionPayloads(top, bottom);

    assert.equal(merged.readUInt16LE(0), 1000, 'the pending top-rail target survives');
    assert.equal(merged.readUInt16LE(2), 8000, 'the newer bottom-rail target is used');
  });

  it('lets a concrete value win over the same axis', () => {
    const first = buildSetPositionPayload({ pos1: 10 });
    const second = buildSetPositionPayload({ pos1: 90 });

    assert.equal(mergeSetPositionPayloads(first, second).readUInt16LE(0), 9000);
  });
});

describe('buildScenePayload', () => {
  it('sends the slot and the fixed second byte', () => {
    assert.deepEqual(buildScenePayload(2), Buffer.from([0x02, 0xa2]));
  });
});

describe('buildTimePayload', () => {
  it('writes the date, the time, and an ISO weekday', () => {
    // 2026-09-07 is a Monday, which is 1 in ISO 8601 and 0 in JavaScript.
    const payload = buildTimePayload(new Date(2026, 8, 7, 14, 30, 45));

    assert.equal(payload.length, 8);
    assert.equal(payload.readUInt16LE(0), 2026);
    assert.deepEqual([...payload.subarray(2)], [9, 7, 14, 30, 45, 1]);
  });

  it('sends 7 for Sunday rather than 0', () => {
    // The shade bounds-checks this byte and refuses anything outside 1..7.
    const payload = buildTimePayload(new Date(2026, 8, 6, 0, 0, 0));
    assert.equal(payload.readUInt8(7), 7);
  });
});

describe('extractShadeRecord', () => {
  const record = Buffer.from('3412060008000000c0', 'hex');

  it('strips the company identifier Homey includes', () => {
    // 2073 little-endian is 19 08.
    const withCompanyId = Buffer.concat([Buffer.from([0x19, 0x08]), record]);
    assert.deepEqual(extractShadeRecord(withCompanyId), record);
  });

  it('rejects a bare record with no company identifier', () => {
    // Homey always includes the prefix, so a record without one is not a
    // shade's - it is some other device that happens to be the right length.
    assert.equal(extractShadeRecord(record), null);
  });

  it('does not mistake an Apple beacon for a shade', () => {
    // Apple's manufacturer data runs nine bytes, exactly a shade record's
    // length. Accepting it read Apple's company ID (0x004C) as a home ID and
    // its nearby-info type as a shade type, so a house full of iPhones and
    // AirPods appeared as seven shades in "home 76" reporting tilts of 148%.
    const apple = Buffer.from('4c0010060a1f8b94c0', 'hex');

    assert.equal(apple.length, ADVERTISEMENT_RECORD_LENGTH, 'same length as a real record');
    assert.equal(extractShadeRecord(apple), null);
  });

  it('rejects data from anything that is not a shade', () => {
    assert.equal(extractShadeRecord(Buffer.from([0x4c, 0x00, 0x02, 0x15])), null, 'an iBeacon');
    assert.equal(extractShadeRecord(Buffer.concat([Buffer.from([0x4c, 0x00]), record])), null,
      'a nine-byte payload from Apple rather than Hunter Douglas');
    assert.equal(extractShadeRecord(null), null);
  });
});

describe('decodeAdvertisement', () => {
  it('decodes an idle Duette at rest', () => {
    const decoded = decodeAdvertisement(Buffer.from('3412060008000000c0', 'hex'));

    assert.equal(decoded.homeId, 0x1234);
    assert.equal(decoded.typeId, 6);
    assert.equal(decoded.position1, 51.2);
    assert.equal(decoded.position2, 0);
    assert.equal(decoded.tilt, 0);
    assert.equal(decoded.isOpening, false);
    assert.equal(decoded.isClosing, false);
    assert.equal(decoded.batteryLevel, 100);
    assert.equal(decoded.clockLost, false);
  });

  it('decodes a shade that is opening, tilted, and low on charge', () => {
    const decoded = decodeAdvertisement(Buffer.from('000027a28f3e002d42', 'hex'));

    assert.equal(decoded.homeId, 0, 'never added to a home');
    assert.equal(decoded.typeId, 39);
    assert.equal(decoded.position1, 100);
    assert.equal(decoded.position2, 25, 'the second rail is read past the first');
    assert.equal(decoded.tilt, 45);
    assert.equal(decoded.isOpening, true);
    assert.equal(decoded.isClosing, false);
    assert.equal(decoded.batteryLevel, 20);
    assert.equal(decoded.clockLost, true);
  });

  it('keeps a second rail from contaminating the first', () => {
    // Byte 4's upper nibble belongs to position 2. Reading it into position 1
    // was a real bug; this pins the masking that fixes it.
    // The two records differ only in byte 4's upper nibble.
    const withoutSecondRail = decodeAdvertisement(Buffer.from('000006000800000000', 'hex'));
    const withSecondRail = decodeAdvertisement(Buffer.from('00000600f800000000', 'hex'));

    assert.equal(withSecondRail.position1, withoutSecondRail.position1);
    assert.ok(withSecondRail.position2 > 0, 'the nibble belongs to the second rail');
  });

  it('reads the motion flags', () => {
    const closing = decodeAdvertisement(Buffer.from('000006010800000000', 'hex'));
    const charging = decodeAdvertisement(Buffer.from('000006030800000000', 'hex'));

    assert.equal(closing.isClosing, true);
    assert.equal(charging.isCharging, true);
  });

  it('returns null for a record of the wrong size', () => {
    assert.equal(decodeAdvertisement(Buffer.alloc(8)), null);
    assert.equal(decodeAdvertisement(null), null);
  });
});

describe('isEncrypted', () => {
  it('follows the home ID, which is what the shade itself reports', () => {
    assert.equal(isEncrypted({ homeId: 0x1234 }), true);
    assert.equal(isEncrypted({ homeId: 0 }), false);
    assert.equal(isEncrypted(null), false);
  });
});

describe('decodePowerStatus', () => {
  it('reads the power type out of a successful reply', () => {
    const hardwired = decodePowerStatus(Buffer.from([0, 1, 0, 0, 0, 0, 0, 0]));
    assert.equal(hardwired.powerType, 1);
    assert.equal(hardwired.isHardwired, true);
    assert.equal(hardwired.isBattery, false);
  });

  it('recognises a battery shade', () => {
    assert.equal(decodePowerStatus(Buffer.from([0, 2, 0, 0, 0, 0, 0, 0])).isBattery, true);
  });

  it('says nothing rather than guessing when the reply is not a success', () => {
    // Type 10 shades answer with a full-length payload whose lead byte is not
    // a success code; reading byte 1 anyway misreported them.
    assert.equal(decodePowerStatus(Buffer.from([6, 2, 0, 0, 0, 0, 0, 1])), null);
    assert.equal(decodePowerStatus(Buffer.alloc(4)), null);
  });
});
