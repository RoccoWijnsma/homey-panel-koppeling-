#!/usr/bin/env node

'use strict';

/**
 * Recover the keystream from the PowerView app's own BLE log.
 *
 * The app writes both halves of every exchange: the frame in the clear, as
 * `[FF 77 02 08 ...]`, and the bytes that actually went over the link, as the
 * hex on the neighbouring `writeWithNotify` or `didUpdateValue` line. Each such
 * pair is a known plaintext against its ciphertext.
 *
 * That is enough because of how the shades encrypt. AES-128-CTR turns the key
 * into a keystream and XORs it over the message - and this firmware restarts
 * the counter at zero for every frame, so every frame is XORed with the *same*
 * keystream. One pair therefore reveals the keystream for as many bytes as the
 * frame is long, and that keystream drives every other command.
 *
 * The key itself stays out of reach: deriving it from the keystream means
 * inverting AES. It is also not needed - the keystream is what does the work.
 *
 * Nothing is sent anywhere. Point it at a log and it prints what it found.
 *
 * Usage:
 *   node scripts/derive-keystream.js <path to blelog.txt>
 */

const fs = require('fs');

/** Frames the shade and app exchange are well under one AES block. */
const KEYSTREAM_BYTES = 16;

const PLAINTEXT = /^\s*\d[\d:.\-]*\s+BLE\s+\[([0-9A-Fa-f ]+)\]\s*$/;
const CIPHERTEXT = /BLE\s+(\S+)\s+[<>]\s*(?:writeWithNotify\(\d+\)|didUpdateValue)\s+([0-9A-Fa-f]{4,})\s*$/;
const DEVICE = /BLE\s+(\S+?)\s/;

/**
 * @param {string} hex Bytes as hex, with or without separators.
 * @returns {Buffer}
 */
function parseHex(hex) {
  return Buffer.from(hex.replace(/[^0-9A-Fa-f]/g, ''), 'hex');
}

/**
 * Walk the log and pair each plaintext frame with its ciphertext.
 *
 * A request logs its plaintext just before the write; a response logs it just
 * after the notification. Rather than encode both orders, this holds whichever
 * half arrives first per device and pairs it with the next of the other kind -
 * which is also what keeps two shades talking at once from being crossed.
 *
 * @param {string} text
 * @returns {{device: string, plain: Buffer, cipher: Buffer}[]}
 */
function collectPairs(text) {
  const pairs = [];
  const pending = new Map();
  let device = 'unknown';

  const take = (key, kind, buffer) => {
    const held = pending.get(key);
    if (held && held.kind !== kind) {
      pending.delete(key);
      const plain = kind === 'plain' ? buffer : held.buffer;
      const cipher = kind === 'plain' ? held.buffer : buffer;
      if (plain.length === cipher.length) {
        pairs.push({ device: key, plain, cipher });
      }
      return;
    }
    pending.set(key, { kind, buffer });
  };

  for (const line of text.split(/\r?\n/)) {
    const cipher = CIPHERTEXT.exec(line);
    if (cipher) {
      device = cipher[1];
      take(device, 'cipher', parseHex(cipher[2]));
      continue;
    }

    const plain = PLAINTEXT.exec(line);
    if (plain) {
      take(device, 'plain', parseHex(plain[1]));
      continue;
    }

    const named = DEVICE.exec(line);
    if (named) device = named[1];
  }

  return pairs;
}

/**
 * Fold every pair into one keystream, byte by byte.
 *
 * Disagreement between pairs means the premise is wrong somewhere - a
 * mismatched pair, or a counter that does not actually restart - so it is
 * reported rather than averaged away.
 *
 * @param {{plain: Buffer, cipher: Buffer}[]} pairs
 * @returns {{keystream: Buffer, support: number[], conflicts: number}}
 */
function deriveKeystream(pairs) {
  const keystream = Buffer.alloc(KEYSTREAM_BYTES);
  const support = new Array(KEYSTREAM_BYTES).fill(0);
  let conflicts = 0;

  for (const { plain, cipher } of pairs) {
    const length = Math.min(plain.length, cipher.length, KEYSTREAM_BYTES);
    for (let i = 0; i < length; i++) {
      const byte = plain[i] ^ cipher[i];
      if (support[i] === 0) {
        keystream[i] = byte;
        support[i] = 1;
      } else if (keystream[i] === byte) {
        support[i] += 1;
      } else {
        conflicts += 1;
      }
    }
  }

  return { keystream, support, conflicts };
}

function main() {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write('Usage: node scripts/derive-keystream.js <blelog.txt>\n');
    process.exit(2);
  }

  const pairs = collectPairs(fs.readFileSync(path, 'latin1'));
  if (pairs.length === 0) {
    process.stderr.write(
      'No plaintext/ciphertext pairs in this log.\n\n'
      + 'Expected lines shaped like "BLE  [FF 77 02 ...]" next to a\n'
      + '"> writeWithNotify(1) <hex>" or "< didUpdateValue <hex>".\n',
    );
    process.exit(1);
  }

  const { keystream, support, conflicts } = deriveKeystream(pairs);
  const covered = support.filter((n) => n > 0).length;

  process.stdout.write(`Pairs found: ${pairs.length}\n`);
  process.stdout.write(`Bytes recovered: ${covered} of ${KEYSTREAM_BYTES}\n`);
  process.stdout.write(`Agreement per byte: ${support.slice(0, covered).join(' ')}\n`);

  if (conflicts > 0) {
    process.stdout.write(`\nConflicting bytes: ${conflicts}\n`);
    process.stdout.write(
      'Pairs disagree, so this keystream is not trustworthy. Either some pair\n'
      + 'was mismatched, or the counter does not restart per frame after all.\n',
    );
    process.exit(1);
  }

  if (keystream.subarray(0, covered).every((b) => b === 0)) {
    process.stdout.write(
      '\nThe keystream is all zeroes, which means this traffic was never\n'
      + 'encrypted: the shades take commands in the clear and need no key.\n',
    );
    return;
  }

  process.stdout.write(`\nKeystream: ${keystream.subarray(0, covered).toString('hex')}\n`);
  process.stdout.write(
    '\nPaste that into Homey under Settings -> Apps -> PowerView BLE.\n'
    + 'Treat it exactly like the home key: anyone within Bluetooth range who\n'
    + 'has it can drive your shades.\n',
  );

  if (covered < 13) {
    process.stdout.write(
      `\nOnly ${covered} bytes were recovered. A position command needs 13, so\n`
      + 'operate the shades from the PowerView app once and re-run this against\n'
      + 'the refreshed log.\n',
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = { KEYSTREAM_BYTES, collectPairs, deriveKeystream, parseHex };
