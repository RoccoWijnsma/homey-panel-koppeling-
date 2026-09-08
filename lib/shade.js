'use strict';

const {
  CMD,
  CONTROL_CHARACTERISTIC_UUID,
  DEVICE_INFO_CHARACTERISTICS,
  DEVICE_INFO_SERVICE_UUID,
  SERVICE_UUID,
} = require('./const');
const {
  buildFrame,
  buildScenePayload,
  buildSetPositionPayload,
  buildTimePayload,
  frameMatches,
  mergeSetPositionPayloads,
  parseFrame,
  readAckStatus,
  transformFrame,
  xorKeystream,
} = require('./protocol');
const { findByUuid } = require('./ble-uuid');

/** How long to wait for a shade to answer a command. */
const DEFAULT_TIMEOUT = 15000;

/**
 * A gateway refreshes every shade's clock at least daily. Match that, so a
 * clock drifting slowly without ever reporting itself lost still gets
 * corrected - on an install with no gateway nothing else would.
 */
const CLOCK_REFRESH_MS = 24 * 60 * 60 * 1000;

class ShadeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ShadeError';
    this.code = code;
  }
}

/**
 * BLE transport for a single PowerView shade.
 *
 * Owns the connection and the command queue; knows nothing about Homey
 * devices or capabilities. One instance per physical shade.
 *
 * Connections are opened per command and closed again afterwards, which is how
 * the shade expects to be talked to - it drops the link itself once it has
 * answered. Commands are serialised, and a position command arriving while
 * another is in flight merges into it rather than queueing, so dragging a
 * slider does not put every intermediate position on the wire.
 */
class PowerViewShade {
  /**
   * @param {object} options
   * @param {object} options.ble Homey's `homey.ble` manager.
   * @param {string} options.peripheralUuid Peripheral UUID as Homey reports it.
   * @param {Buffer|null} [options.homeKey] 16-byte AES key, or null if the
   *   shade is unencrypted.
   * @param {Buffer|null} [options.keystream] Keystream recovered from the
   *   vendor app's log, for installs where the key itself cannot be had. Takes
   *   precedence over the key when both are present.
   * @param {boolean} [options.encrypted] Whether the shade expects encryption.
   * @param {(...args: any[]) => void} [options.log]
   * @param {(...args: any[]) => void} [options.error]
   * @param {number} [options.timeout]
   */
  constructor({
    ble,
    peripheralUuid,
    homeKey = null,
    keystream = null,
    encrypted = false,
    log = () => {},
    error = () => {},
    timeout = DEFAULT_TIMEOUT,
  }) {
    this.ble = ble;
    this.peripheralUuid = peripheralUuid;
    this.homeKey = homeKey;
    this.keystream = keystream;
    this.encrypted = encrypted;
    this.timeout = timeout;
    this.log = log;
    this.error = error;

    /**
     * Whether the shade has reported losing its clock. Null until an
     * advertisement has been decoded - and unknown counts as "needs setting",
     * because a shade we cannot currently hear may have rebooted unseen.
     * @type {boolean|null}
     */
    this.clockLost = null;

    this._peripheral = null;
    this._characteristic = null;
    this._sequence = 1;
    this._waiter = null;
    this._next = null;
    this._busy = false;
    this._chain = Promise.resolve();
    this._lastClockSet = 0;
  }

  /** @returns {boolean} */
  get isConnected() {
    return Boolean(this._peripheral && this._peripheral.isConnected);
  }

  /**
   * @returns {boolean} Whether commands can be sent. An encrypted shade with
   *   neither secret silently ignores everything, so this is worth checking
   *   before promising the user anything.
   */
  get canControl() {
    return !this.encrypted || Boolean(this.keystream || this.homeKey);
  }

  /**
   * Encrypt or decrypt a frame - the same operation either way, since both
   * schemes are an XOR against a keystream.
   *
   * @param {Buffer} data
   * @returns {Buffer}
   */
  _transform(data) {
    if (this.keystream) return xorKeystream(data, this.keystream);
    return transformFrame(data, this.homeKey);
  }

  // --- commands -------------------------------------------------------------

  /**
   * Move one or more axes.
   *
   * Axes left undefined are not moved: the protocol has a "leave as is"
   * sentinel and {@link buildSetPositionPayload} sends it for anything the
   * caller did not name.
   *
   * @param {object} move
   * @param {number} [move.pos1] Primary rail, 0..100 (0 closed, 100 open).
   * @param {number} [move.pos2] Secondary rail, 0..100.
   * @param {number} [move.pos3] Third axis, 0..100.
   * @param {number} [move.tilt] Tilt, 0..100.
   * @param {number} [move.velocity] 0 to let the shade choose, else 10..100.
   * @returns {Promise<void>}
   */
  async setPosition(move) {
    return this._send(CMD.SET_POSITION, buildSetPositionPayload(move));
  }

  /** @returns {Promise<void>} */
  async stop() {
    return this._send(CMD.STOP, Buffer.alloc(0));
  }

  /**
   * @param {number} index Scene slot stored on the shade.
   * @returns {Promise<void>}
   */
  async activateScene(index) {
    return this._send(CMD.ACTIVATE_SCENE, buildScenePayload(index));
  }

  /**
   * Make the shade announce itself, so it can be told apart from its siblings.
   *
   * @param {number} [beeps]
   * @returns {Promise<void>}
   */
  async identify(beeps = 3) {
    return this._send(CMD.IDENTIFY, Buffer.from([Math.min(Math.max(beeps, 0), 0xff)]));
  }

  /**
   * Read the raw power-status reply.
   *
   * Returned uninterpreted on purpose: the encoding is not fully established,
   * so callers decode it themselves and treat anything unexpected as unknown.
   *
   * @returns {Promise<Buffer>}
   */
  async readPowerStatus() {
    return this._query(CMD.POWER_STATUS, Buffer.alloc(0));
  }

  /**
   * Read the standard Device Information strings.
   *
   * @returns {Promise<Record<string, string>>} Only the fields the shade
   *   actually answered; a shade that refuses one simply omits it.
   */
  async readDeviceInfo() {
    const info = {};
    await this._withConnection(async (peripheral) => {
      const service = findByUuid(peripheral.services, DEVICE_INFO_SERVICE_UUID);
      if (!service) return;

      for (const [field, uuid] of Object.entries(DEVICE_INFO_CHARACTERISTICS)) {
        const characteristic = findByUuid(service.characteristics, uuid);
        if (!characteristic) continue;
        try {
          const value = await this._withTimeout(characteristic.read(), `read ${field}`);
          info[field] = value.toString('utf8').replace(/\0+$/, '').trim();
        } catch (err) {
          this.log(`could not read ${field}: ${err.message}`);
        }
      }
    });
    return info;
  }

  // --- queue ----------------------------------------------------------------

  /**
   * Stage a command and, unless another call is already draining the queue,
   * drain it.
   *
   * A caller whose command is superseded still resolves: the newer command is
   * what the user asked for, and the older one reaching the shade would undo
   * it.
   *
   * @param {number} opcode
   * @param {Buffer} payload
   * @returns {Promise<void>}
   */
  async _send(opcode, payload) {
    this._stage(opcode, payload);
    if (this._busy) return;

    this._busy = true;
    try {
      await this._runExclusive(async () => {
        for (;;) {
          if (!this._next) return;
          await this._connect();

          // Re-read after connecting: a command that arrived while the link was
          // coming up should merge into this one rather than be sent after it.
          const command = this._next;
          if (!command) return;
          this._next = null;

          try {
            const frame = await this._transact(command.opcode, command.payload);
            const status = readAckStatus(frame);
            if (status !== null && status !== 0) {
              throw new ShadeError(
                `Shade refused command 0x${command.opcode.toString(16)} with status 0x${status.toString(16)}`,
                status,
              );
            }
          } finally {
            // The shade drops the link itself once it has answered; closing
            // from this side keeps Homey's view of the connection in step.
            await this.disconnect();
          }
        }
      });
    } finally {
      this._busy = false;
    }
  }

  /**
   * Run `fn` with sole use of the connection.
   *
   * Commands coalesce behind `_busy` before they reach this, so the queue is
   * not what this guards - queries are. A device-information read landing
   * while a move is in flight would otherwise share the link and overwrite the
   * move's pending reply, and both would be lost.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async _runExclusive(fn) {
    const previous = this._chain;
    let release;
    this._chain = new Promise((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * @param {number} opcode
   * @param {Buffer} payload
   */
  _stage(opcode, payload) {
    if (this._next && this._next.opcode === CMD.SET_POSITION && opcode === CMD.SET_POSITION) {
      this._next = {
        opcode,
        payload: mergeSetPositionPayloads(this._next.payload, payload),
      };
      return;
    }
    this._next = { opcode, payload };
  }

  /**
   * Send a read-type opcode and return its payload.
   *
   * Queries bypass the command queue's coalescing - there is nothing to merge -
   * but still take the connection, so they cannot interleave with a move.
   *
   * @param {number} opcode
   * @param {Buffer} payload
   * @returns {Promise<Buffer>}
   */
  async _query(opcode, payload) {
    let result = Buffer.alloc(0);
    await this._withConnection(async () => {
      const frame = await this._transact(opcode, payload);
      result = Buffer.from(frame.payload);
    });
    return result;
  }

  // --- transport ------------------------------------------------------------

  /**
   * Write a framed request and wait for the shade's reply.
   *
   * @param {number} opcode
   * @param {Buffer} payload
   * @returns {Promise<ReturnType<typeof parseFrame>>}
   */
  async _transact(opcode, payload) {
    if (!this._characteristic) {
      throw new ShadeError('Not connected', 'not_connected');
    }
    if (!this.canControl) {
      throw new ShadeError(
        'This shade is paired to a PowerView home and needs its home key, or a keystream, before it will accept commands',
        'missing_home_key',
      );
    }

    const sequence = this._sequence;
    // The sequence field is one byte and the shade echoes one byte back, so
    // the counter has to stay inside it. Cycles 1..255.
    this._sequence = (this._sequence % 0xff) + 1;

    let frame = buildFrame(opcode, sequence, payload);
    if (this.encrypted) {
      frame = this._transform(frame);
    }

    const reply = this._waitForReply(opcode, sequence);
    try {
      await this._withTimeout(this._characteristic.write(frame), 'write command');
      return await reply;
    } finally {
      this._waiter = null;
    }
  }

  /**
   * @param {number} opcode
   * @param {number} sequence
   * @returns {Promise<ReturnType<typeof parseFrame>>}
   */
  _waitForReply(opcode, sequence) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiter = null;
        reject(new ShadeError('Shade did not answer in time', 'timeout'));
      }, this.timeout);

      this._waiter = {
        opcode,
        sequence,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
    });
  }

  /**
   * @param {Buffer} data Raw notification payload.
   */
  _onNotification(data) {
    let plain = data;
    if (this.encrypted && this.canControl) {
      try {
        plain = this._transform(data);
      } catch (err) {
        this.error(`could not decrypt reply: ${err.message}`);
        return;
      }
    }

    const frame = parseFrame(plain);
    if (!frame) return;

    const waiter = this._waiter;
    if (!waiter) return;
    if (!frameMatches(frame, waiter.opcode, waiter.sequence)) {
      // A reply to a command that already timed out, or a wrong home key
      // turning a valid frame into noise. Either way it is not ours.
      return;
    }
    this._waiter = null;
    waiter.resolve(frame);
  }

  // --- connection -----------------------------------------------------------

  /**
   * Open the link and subscribe to replies, unless that is already done.
   *
   * @returns {Promise<void>}
   */
  async _connect() {
    if (this.isConnected && this._characteristic) return;

    // Anything left from a dropped link would point at a dead peripheral.
    this._characteristic = null;
    this._peripheral = null;

    const advertisement = await this._withTimeout(
      this.ble.find(this.peripheralUuid),
      'find shade',
    );
    const peripheral = await this._withTimeout(advertisement.connect(), 'connect');
    this._peripheral = peripheral;

    await this._withTimeout(
      peripheral.discoverAllServicesAndCharacteristics(),
      'discover services',
    );

    const service = findByUuid(peripheral.services, SERVICE_UUID);
    if (!service) {
      await this.disconnect();
      throw new ShadeError('Shade does not expose the PowerView service', 'no_service');
    }

    const characteristic = findByUuid(service.characteristics, CONTROL_CHARACTERISTIC_UUID);
    if (!characteristic) {
      await this.disconnect();
      throw new ShadeError(
        'Shade does not expose the PowerView control characteristic',
        'no_characteristic',
      );
    }

    this._reportWriteSupport(characteristic);

    await this._withTimeout(
      characteristic.subscribeToNotifications((data) => this._onNotification(data)),
      'subscribe',
    );
    this._characteristic = characteristic;

    await this._pushClock();
  }

  /**
   * Say what the control characteristic actually allows, once per connection.
   *
   * The reference implementation writes without waiting for a response, and
   * Homey's BLE API gives no way to ask for that - it writes however it sees
   * fit. If a shade ever accepts commands and then does nothing, this line is
   * the first thing to look at: a characteristic offering only
   * `writeWithoutResponse` would explain it, and nothing else in the log would.
   *
   * @param {{properties?: string[]}} characteristic
   */
  _reportWriteSupport(characteristic) {
    const properties = Array.isArray(characteristic.properties) ? characteristic.properties : [];
    this.log(`control characteristic allows: ${properties.join(', ') || '(nothing reported)'}`);

    if (properties.length > 0 && !properties.includes('write')) {
      this.log(
        'this characteristic does not offer a plain write; if commands are accepted but nothing moves, that is the first thing to suspect',
      );
    }
  }

  /**
   * Run `fn` with an open connection, closing it afterwards either way.
   *
   * @template T
   * @param {(peripheral: object) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async _withConnection(fn) {
    return this._runExclusive(async () => {
      await this._connect();
      try {
        return await fn(this._peripheral);
      } finally {
        await this.disconnect();
      }
    });
  }

  /** @returns {Promise<void>} */
  async disconnect() {
    const peripheral = this._peripheral;
    this._characteristic = null;
    this._peripheral = null;
    if (!peripheral) return;

    try {
      if (peripheral.isConnected) await peripheral.disconnect();
    } catch (err) {
      this.log(`disconnect failed: ${err.message}`);
    }
  }

  // --- housekeeping ---------------------------------------------------------

  /**
   * Tell the shade the time, if it needs telling.
   *
   * A shade that loses power stops its clock and comes back not knowing the
   * time, which leaves its stored schedules dormant. Nothing else on a
   * gateway-less install would ever correct that.
   *
   * Best effort by design: this is an unsolicited extra, so a shade that
   * refuses it must not take down the command the caller actually asked for.
   *
   * @returns {Promise<void>}
   */
  async _pushClock() {
    if (this.encrypted && !this.canControl) return; // would put plaintext on the wire
    if (!this._clockDue()) return;

    try {
      const frame = await this._transact(CMD.SET_TIME, buildTimePayload(new Date()));
      const status = readAckStatus(frame);
      if (status !== 0) {
        this.log(`shade refused clock update, status ${status}`);
        return;
      }
      this._lastClockSet = Date.now();
      this.clockLost = false;
    } catch (err) {
      this.log(`clock update failed: ${err.message}`);
    }
  }

  /** @returns {boolean} */
  _clockDue() {
    if (this.clockLost !== false) return true; // asked for it, or nothing decoded yet
    if (this._lastClockSet === 0) return true; // establish a baseline this session
    return Date.now() - this._lastClockSet >= CLOCK_REFRESH_MS;
  }

  /**
   * @template T
   * @param {Promise<T>} promise
   * @param {string} what Used in the error message when it does not settle.
   * @returns {Promise<T>}
   */
  _withTimeout(promise, what) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new ShadeError(`Timed out trying to ${what}`, 'timeout')),
        this.timeout,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}

module.exports = { CLOCK_REFRESH_MS, DEFAULT_TIMEOUT, PowerViewShade, ShadeError };
