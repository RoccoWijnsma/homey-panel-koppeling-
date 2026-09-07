'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { CONTROL_CHARACTERISTIC_UUID, SERVICE_UUID } = require('../lib/const');
const { equals, findByUuid, normalize } = require('../lib/ble-uuid');

describe('normalize', () => {
  it('shortens a SIG-assigned UUID to its 16-bit form, the way Homey reports it', () => {
    assert.equal(normalize(SERVICE_UUID), 'fdc1');
    assert.equal(normalize('00002a29-0000-1000-8000-00805F9B34FB'), '2a29');
  });

  it('leaves a vendor UUID at full length, minus the dashes', () => {
    assert.equal(normalize(CONTROL_CHARACTERISTIC_UUID), 'cafe1001c0ffee018000a110ca7ab1e0');
  });

  it('is idempotent, so an already-short UUID survives', () => {
    assert.equal(normalize(normalize(SERVICE_UUID)), 'fdc1');
  });

  it('does not shorten a UUID that merely resembles the base', () => {
    assert.equal(normalize('0000fdc1-0000-1000-8000-00805f9b34ff').length, 32);
  });

  it('copes with nonsense', () => {
    assert.equal(normalize(null), '');
    assert.equal(normalize(42), '');
  });
});

describe('equals and findByUuid', () => {
  it('matches the two forms against each other', () => {
    assert.equal(equals('fdc1', SERVICE_UUID), true);
    assert.equal(equals('fdc2', SERVICE_UUID), false);
  });

  it('finds a service Homey named in short form from the constant\'s long one', () => {
    const services = [{ uuid: '180a' }, { uuid: 'fdc1' }];
    assert.deepEqual(findByUuid(services, SERVICE_UUID), { uuid: 'fdc1' });
  });

  it('returns nothing when there is no match', () => {
    assert.equal(findByUuid([{ uuid: '180a' }], SERVICE_UUID), undefined);
    assert.equal(findByUuid(null, SERVICE_UUID), undefined);
  });
});
