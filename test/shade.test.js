'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  ACK_OPCODE_MASK,
  CMD,
  CONTROL_CHARACTERISTIC_UUID,
  DEVICE_INFO_SERVICE_UUID,
  KEEP_POSITION,
  SERVICE_UUID,
} = require('../lib/const');
const { parseFrame, transformFrame } = require('../lib/protocol');
const { PowerViewShade } = require('../lib/shade');

const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');

/**
 * A stand-in for Homey's Bluetooth stack that behaves the way a shade does:
 * it answers each framed request with an acknowledgement carrying the same
 * opcode (bit 4 cleared) and sequence number, then lets the link be closed.
 *
 * @param {object} [options]
 * @param {Buffer|null} [options.homeKey] Key the fake expects traffic under.
 * @param {number} [options.replyDelayMs] How long the shade takes to answer.
 * @param {boolean} [options.reply] Set false to model a shade that never answers.
 * @param {number} [options.status] Status byte to answer with; 0 is success.
 * @param {boolean} [options.omitService] Model a peripheral that is not a shade.
 */
function createFakeBle({
  homeKey = null,
  replyDelayMs = 0,
  reply = true,
  status = 0,
  omitService = false,
} = {}) {
  const state = { writes: [], connects: 0, disconnects: 0, subscriptions: 0 };
  let notify = null;

  const controlCharacteristic = {
    uuid: CONTROL_CHARACTERISTIC_UUID,
    async subscribeToNotifications(callback) {
      notify = callback;
      state.subscriptions += 1;
    },
    async read() {
      return Buffer.from('');
    },
    async write(data) {
      const plain = homeKey ? transformFrame(data, homeKey) : Buffer.from(data);
      state.writes.push(plain);
      if (!reply) return Buffer.alloc(0);

      const frame = parseFrame(plain);
      const ack = Buffer.alloc(5);
      ack.writeUInt16LE(frame.opcode & ACK_OPCODE_MASK, 0);
      ack.writeUInt8(frame.sequence, 2);
      ack.writeUInt8(1, 3);
      ack.writeUInt8(status, 4);

      setTimeout(() => {
        if (notify) notify(homeKey ? transformFrame(ack, homeKey) : ack);
      }, replyDelayMs);
      return Buffer.alloc(0);
    },
  };

  const services = omitService
    ? []
    : [
      { uuid: SERVICE_UUID, characteristics: [controlCharacteristic] },
      {
        uuid: DEVICE_INFO_SERVICE_UUID,
        characteristics: [
          { uuid: '00002a26-0000-1000-8000-00805f9b34fb', async read() { return Buffer.from('22'); } },
        ],
      },
    ];

  const peripheral = {
    isConnected: false,
    services: [],
    async discoverAllServicesAndCharacteristics() {
      this.services = services;
      return services;
    },
    async disconnect() {
      this.isConnected = false;
      state.disconnects += 1;
    },
  };

  const ble = {
    async find() {
      return {
        uuid: 'abc',
        async connect() {
          peripheral.isConnected = true;
          state.connects += 1;
          return peripheral;
        },
      };
    },
  };

  return { ble, state, peripheral };
}

/**
 * Everything the shade was sent except the clock updates it gets unasked.
 *
 * @param {Buffer[]} writes
 * @returns {ReturnType<typeof parseFrame>[]}
 */
function commands(writes) {
  return writes.map(parseFrame).filter((frame) => frame.opcode !== CMD.SET_TIME);
}

function makeShade(ble, overrides = {}) {
  return new PowerViewShade({ ble, peripheralUuid: 'abc', timeout: 500, ...overrides });
}

describe('sending a command', () => {
  it('connects, subscribes, writes, and closes the link again', async () => {
    const { ble, state } = createFakeBle();
    const shade = makeShade(ble);

    await shade.setPosition({ pos1: 40 });

    assert.equal(state.connects, 1);
    assert.equal(state.subscriptions, 1, 'replies arrive as notifications');
    assert.equal(state.disconnects, 1, 'the shade expects the link to be closed');
    assert.equal(shade.isConnected, false);
  });

  it('frames the position the way the shade expects', async () => {
    const { ble, state } = createFakeBle();

    await makeShade(ble).setPosition({ pos1: 40, velocity: 60 });

    const [command] = commands(state.writes);
    assert.equal(command.opcode, CMD.SET_POSITION);
    assert.equal(command.payload.readUInt16LE(0), 4000);
    assert.equal(command.payload.readUInt16LE(2), KEEP_POSITION);
    assert.equal(command.payload.readUInt8(8), 60);
  });

  it('tells the shade the time on a fresh connection', async () => {
    // A shade that lost power has a stopped clock and dormant schedules, and
    // on an install with no gateway nothing else would ever correct that.
    const { ble, state } = createFakeBle();

    await makeShade(ble).stop();

    assert.equal(state.writes.map(parseFrame)[0].opcode, CMD.SET_TIME);
  });

  it('numbers each request so replies can be told apart', async () => {
    const { ble, state } = createFakeBle();
    const shade = makeShade(ble);

    await shade.stop();
    await shade.stop();

    const sequences = state.writes.map((write) => parseFrame(write).sequence);
    assert.deepEqual(sequences, [...new Set(sequences)], 'no sequence number is reused');
  });

  it('raises the status the shade refused with', async () => {
    // 0x80 is "invalid field value".
    const { ble } = createFakeBle({ status: 0x80 });

    await assert.rejects(makeShade(ble).identify(), /status 0x80/);
  });

  it('gives up rather than hanging when the shade never answers', async () => {
    const { ble } = createFakeBle({ reply: false });

    await assert.rejects(makeShade(ble).stop(), /did not answer in time/);
  });

  it('refuses a peripheral that is not a PowerView shade', async () => {
    const { ble } = createFakeBle({ omitService: true });

    await assert.rejects(makeShade(ble).stop(), /does not expose the PowerView service/);
  });
});

describe('encryption', () => {
  it('encrypts every frame once a key is set', async () => {
    const { ble, state } = createFakeBle({ homeKey: KEY });
    const shade = makeShade(ble, { homeKey: KEY, encrypted: true });

    await shade.setPosition({ pos1: 10 });

    // The fake decrypts before recording, so a readable frame here proves both
    // directions used the key.
    const [command] = commands(state.writes);
    assert.equal(command.opcode, CMD.SET_POSITION);
    assert.equal(command.payload.readUInt16LE(0), 1000);
  });

  it('refuses to put plaintext on the wire when the key is missing', async () => {
    // The shade would accept the write and silently ignore it, which looks
    // exactly like a shade that is stuck.
    const { ble } = createFakeBle();
    const shade = makeShade(ble, { encrypted: true });

    assert.equal(shade.canControl, false);
    await assert.rejects(shade.setPosition({ pos1: 10 }), /home key/);
  });

  it('needs no key when the shade was never added to a home', async () => {
    const { ble } = createFakeBle();
    const shade = makeShade(ble, { encrypted: false });

    assert.equal(shade.canControl, true);
    await shade.setPosition({ pos1: 10 });
  });
});

describe('the command queue', () => {
  it('merges moves that arrive together into one command', async () => {
    // Dragging a slider, or two rails moving at once, must not put every
    // intermediate position on the wire.
    const { ble, state } = createFakeBle({ replyDelayMs: 20 });
    const shade = makeShade(ble);

    await Promise.all([
      shade.setPosition({ pos1: 10 }),
      shade.setPosition({ pos2: 80 }),
    ]);

    const sent = commands(state.writes);
    assert.equal(sent.length, 1, 'one command, not two');
    assert.equal(sent[0].payload.readUInt16LE(0), 1000, 'the first target survived');
    assert.equal(sent[0].payload.readUInt16LE(2), 8000, 'the second one too');
  });

  it('lets a later command supersede a queued one of another kind', async () => {
    const { ble, state } = createFakeBle({ replyDelayMs: 20 });
    const shade = makeShade(ble);

    await Promise.all([
      shade.setPosition({ pos1: 10 }),
      shade.stop(),
    ]);

    const sent = commands(state.writes);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].opcode, CMD.STOP, 'the newest command is what the user wants');
  });

  it('sends a command that arrives while the shade is busy', async () => {
    const { ble, state } = createFakeBle({ replyDelayMs: 20 });
    const shade = makeShade(ble);

    const first = shade.setPosition({ pos1: 10 });
    await new Promise((resolve) => setTimeout(resolve, 5)); // land mid-flight
    const second = shade.identify();
    await Promise.all([first, second]);

    const opcodes = commands(state.writes).map((frame) => frame.opcode);
    assert.ok(opcodes.includes(CMD.IDENTIFY), 'nothing is dropped on the floor');
  });
});

describe('reading device information', () => {
  it('returns the strings the shade answered with', async () => {
    const { ble } = createFakeBle();

    const info = await makeShade(ble).readDeviceInfo();

    assert.equal(info.firmwareRevision, '22');
    assert.equal(info.model, undefined, 'a field the shade does not expose is simply absent');
  });

  it('waits for a move rather than sharing its connection', async () => {
    // Both use the same characteristic and the same pending-reply slot, so an
    // overlap would lose one side's answer and time it out.
    const { ble, state } = createFakeBle({ replyDelayMs: 20 });
    const shade = makeShade(ble);

    const move = shade.setPosition({ pos1: 30 });
    const info = shade.readDeviceInfo();

    await assert.doesNotReject(Promise.all([move, info]));
    assert.equal(state.connects, 2, 'one connection each, one after the other');
  });
});
