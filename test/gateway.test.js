'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { GET_SHADE_KEY_FRAME, normalizeHost, parseKeyResponse } = require('../lib/gateway');

const KEY = Buffer.alloc(16, 0xab);

/**
 * @param {Buffer} payload Everything after the four-byte header.
 * @returns {object} A gateway `exec` response carrying that frame.
 */
function response(payload) {
  const frame = Buffer.concat([Buffer.from([251, 18, 1, payload.length]), payload]);
  return { responses: [{ hex: frame.toString('hex') }] };
}

describe('the key request', () => {
  it('asks for service 251, command 18', () => {
    assert.equal(GET_SHADE_KEY_FRAME, 'fb120100');
  });
});

describe('parseKeyResponse', () => {
  it('reads the key out of a successful reply', () => {
    const payload = Buffer.concat([Buffer.from([0]), KEY]);
    assert.deepEqual(parseKeyResponse(response(payload)), KEY);
  });

  it('declines a reply whose status byte is not success', () => {
    const payload = Buffer.concat([Buffer.from([4]), KEY]);
    assert.equal(parseKeyResponse(response(payload)), null);
  });

  it('declines a key of the wrong length', () => {
    const payload = Buffer.concat([Buffer.from([0]), Buffer.alloc(8)]);
    assert.equal(parseKeyResponse(response(payload)), null);
  });

  it('declines a frame whose header disagrees with its length', () => {
    const truncated = { responses: [{ hex: 'fb1201110000' }] };
    assert.equal(parseKeyResponse(truncated), null);
  });

  it('declines an error the gateway reports itself', () => {
    // err=8 is the timeout the gateway gives while it opens its own BLE link.
    assert.equal(parseKeyResponse({ err: 8, responses: [{ errMsg: 'command timed out' }] }), null);
  });

  it('declines anything shaped unlike a reply', () => {
    assert.equal(parseKeyResponse(null), null);
    assert.equal(parseKeyResponse({}), null);
    assert.equal(parseKeyResponse({ responses: [] }), null);
    assert.equal(parseKeyResponse({ responses: [{}, {}] }), null);
  });
});

describe('normalizeHost', () => {
  it('accepts whatever shape the address was pasted in', () => {
    assert.equal(normalizeHost('http://powerview-g3.local/'), 'powerview-g3.local');
    assert.equal(normalizeHost('https://192.168.1.10'), '192.168.1.10');
    assert.equal(normalizeHost('192.168.1.10:80'), '192.168.1.10');
    assert.equal(normalizeHost('  pv.lan  '), 'pv.lan');
    assert.equal(normalizeHost('powerview-g3.local/home/shades'), 'powerview-g3.local');
  });

  it('returns nothing for nothing', () => {
    assert.equal(normalizeHost(''), '');
    assert.equal(normalizeHost(null), '');
  });
});
