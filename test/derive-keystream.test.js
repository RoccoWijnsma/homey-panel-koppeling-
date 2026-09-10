'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { collectPairs, deriveKeystream } = require('../scripts/derive-keystream');

const KEYSTREAM = Buffer.from('27ec9a4f13b8005ce1220d7f6a34c9de', 'hex');

/**
 * @param {string} spaced Frame bytes as the app logs them.
 * @returns {string} The same frame as it goes over the link.
 */
function encrypt(spaced) {
  const plain = Buffer.from(spaced.replace(/ /g, ''), 'hex');
  const out = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i++) out[i] = plain[i] ^ KEYSTREAM[i];
  return out.toString('hex').toUpperCase();
}

/**
 * A log in the shape the PowerView app writes, with a request whose plaintext
 * precedes its ciphertext and a response whose plaintext follows it.
 *
 * @param {string} device
 * @param {string} request
 * @param {string} response
 * @returns {string}
 */
function exchange(device, request, response) {
  return [
    `02-07:14:16.225 BLE ${device} GetTime.Request`,
    `02-07:14:16.225 BLE          [${request}]`,
    `02-07:14:16.225 BLE ${device}    > writeWithNotify(1) ${encrypt(request)}`,
    `02-07:14:16.285 BLE ${device}    > didWriteValue `,
    `02-07:14:16.346 BLE ${device}    < didUpdateValue ${encrypt(response)}`,
    `02-07:14:16.347 BLE ${device} GetTime.Response`,
    `02-07:14:16.347 BLE          [${response}]`,
  ].join('\n');
}

describe('reading the app\'s BLE log', () => {
  it('pairs a request\'s plaintext with the bytes that followed it', () => {
    const pairs = collectPairs(exchange('DU1:C1F9', 'FF 67 01 00', 'EF 67 01 01 00'));

    assert.equal(pairs.length, 2, 'the request and the response');
    assert.deepEqual(pairs[0].plain, Buffer.from('FF670100', 'hex'));
    assert.equal(pairs[0].device, 'DU1:C1F9');
  });

  it('keeps two shades talking at once from being crossed', () => {
    // The app interleaves devices freely; a pair spanning two of them would
    // XOR unrelated frames together and produce a plausible-looking lie.
    const log = [
      '02-07:14:16.225 BLE DU1:C1F9 GetTime.Request',
      '02-07:14:16.225 BLE          [FF 67 01 00]',
      '02-07:14:16.487 BLE DU1:64D6 +connect',
      `02-07:14:16.225 BLE DU1:C1F9    > writeWithNotify(1) ${encrypt('FF 67 01 00')}`,
    ].join('\n');

    const pairs = collectPairs(log);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].device, 'DU1:C1F9');
  });

  it('ignores a pair whose halves are different lengths', () => {
    const log = [
      '02-07:14:16.225 BLE DU1:C1F9 GetTime.Request',
      '02-07:14:16.225 BLE          [FF 67 01 00]',
      '02-07:14:16.225 BLE DU1:C1F9    > writeWithNotify(1) AABBCC',
    ].join('\n');

    assert.equal(collectPairs(log).length, 0);
  });
});

describe('deriving the keystream', () => {
  it('recovers it from a single pair, for as far as the frame reaches', () => {
    const pairs = collectPairs(exchange('DU1:C1F9', 'FF 67 01 00', 'EF 67 01 01 00'));
    const { keystream, support, conflicts } = deriveKeystream(pairs);

    assert.equal(conflicts, 0);
    assert.deepEqual(keystream.subarray(0, 4), KEYSTREAM.subarray(0, 4));
    assert.deepEqual(support.slice(0, 4), [2, 2, 2, 2], 'both frames cover these');
    assert.equal(support[4], 1, 'only the longer frame reaches here');
  });

  it('reaches further as longer frames appear', () => {
    const log = [
      exchange('DU1:C1F9', 'FF 67 01 00', 'EF 67 01 09 00 EA 07 07 02 07 0E 19 04'),
      exchange('DU1:C1F9', 'FF 77 02 08 EA 07 07 02 07 0E 10 04', 'EF 77 02 01 00'),
    ].join('\n');

    const { keystream, conflicts } = deriveKeystream(collectPairs(log));

    assert.equal(conflicts, 0);
    assert.deepEqual(keystream.subarray(0, 13), KEYSTREAM.subarray(0, 13),
      'enough for a position command');
  });

  it('reports disagreement rather than averaging it away', () => {
    // If the counter did not restart per frame, pairs would disagree - and a
    // keystream folded together from them would be confidently wrong.
    const log = [
      '02-07:14:16.225 BLE DU1:C1F9 A.Request',
      '02-07:14:16.225 BLE          [FF 67 01 00]',
      `02-07:14:16.225 BLE DU1:C1F9    > writeWithNotify(1) ${encrypt('FF 67 01 00')}`,
      '02-07:14:17.225 BLE DU1:C1F9 B.Request',
      '02-07:14:17.225 BLE          [FF 67 02 00]',
      '02-07:14:17.225 BLE DU1:C1F9    > writeWithNotify(1) 00000000',
    ].join('\n');

    assert.ok(deriveKeystream(collectPairs(log)).conflicts > 0);
  });

  it('comes out all zeroes when the traffic was never encrypted', () => {
    const log = [
      '02-07:14:16.225 BLE DU1:C1F9 A.Request',
      '02-07:14:16.225 BLE          [FF 67 01 00]',
      '02-07:14:16.225 BLE DU1:C1F9    > writeWithNotify(1) FF670100',
    ].join('\n');

    const { keystream, conflicts } = deriveKeystream(collectPairs(log));
    assert.equal(conflicts, 0);
    assert.deepEqual(keystream.subarray(0, 4), Buffer.alloc(4));
  });
});
