'use strict';

const http = require('http');

const { HOME_KEY_LENGTH } = require('./const');

/**
 * Pulling the home key out of a PowerView Gen 3 gateway.
 *
 * Only useful to people who own a gateway, which is exactly the people who
 * least need this app. It earns its place anyway: it is by far the least
 * painful way to get the key, and someone who has a gateway but wants Homey to
 * drive the shades directly - for speed, or to keep working when the gateway
 * is off the network - can get set up in one step.
 *
 * The gateway proxies a BLE request to a shade, and the shade answers with the
 * key. Any shade returns the same value: the key belongs to the home, not the
 * shade.
 */

/** BLE request the gateway relays: service 251, command 18, sequence 1, no payload. */
const GET_SHADE_KEY_FRAME = Buffer.from([251, 18, 1, 0]).toString('hex');

/**
 * The gateway opens its BLE link to a shade on demand, so the first request to
 * each usually times out while that connection is established. Retrying the
 * whole list gives those connections time to settle.
 */
const PASSES = 3;
const PASS_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;

class GatewayError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
  }
}

/**
 * Minimal JSON-over-HTTP request. The gateway speaks plain HTTP on port 80 and
 * needs no authentication, so this stays smaller than pulling in a client.
 *
 * @param {object} options
 * @param {string} options.host Hostname or IP, without a scheme.
 * @param {string} options.path
 * @param {'GET'|'POST'} [options.method]
 * @param {object} [options.body]
 * @returns {Promise<any>} The decoded JSON body.
 */
function request({ host, path, method = 'GET', body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host,
        port: 80,
        path,
        method,
        timeout: REQUEST_TIMEOUT_MS,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new GatewayError(`Gateway answered ${res.statusCode}`, 'http_error'));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : null);
          } catch (err) {
            reject(new GatewayError('Gateway sent something that is not JSON', 'bad_json'));
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new GatewayError('Gateway did not answer in time', 'timeout'));
    });
    req.on('error', (err) => {
      reject(err instanceof GatewayError ? err : new GatewayError(err.message, 'connection_error'));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Pull the 16-byte key out of one shade's reply.
 *
 * @param {any} result Decoded `/home/shades/exec` response.
 * @returns {Buffer|null} The key, or null if this shade did not supply one.
 */
function parseKeyResponse(result) {
  if (!result || result.err) return null;

  const responses = Array.isArray(result.responses) ? result.responses : [];
  if (responses.length !== 1 || typeof responses[0].hex !== 'string') return null;

  const frame = Buffer.from(responses[0].hex, 'hex');
  if (frame.length < 5) return null;

  // Header is service, command, sequence, payload length - then a status byte.
  const length = frame[3];
  if (frame.length !== 4 + length) return null;
  if (frame[4] !== 0) return null;

  const key = frame.subarray(5);
  return key.length === HOME_KEY_LENGTH ? key : null;
}

/**
 * Ask a PowerView Gen 3 gateway for the home key.
 *
 * @param {string} host Hostname or IP of the gateway, e.g. `powerview-g3.local`.
 * @param {object} [options]
 * @param {(ms: number) => Promise<void>} [options.sleep] Injected for tests.
 * @param {(...args: any[]) => void} [options.log]
 * @returns {Promise<Buffer>} The 16-byte key.
 * @throws {GatewayError} When no shade on the gateway supplied one.
 */
async function fetchHomeKey(host, { sleep = defaultSleep, log = () => {} } = {}) {
  const shades = await request({ host, path: '/home/shades' });
  if (!Array.isArray(shades) || shades.length === 0) {
    throw new GatewayError('The gateway does not list any shades', 'no_shades');
  }

  // Strongest signal first: the gateway is likeliest to already hold an open
  // BLE link to those, so they answer on an earlier pass.
  const bleNames = shades
    .slice()
    .sort((a, b) => (b.signalStrength ?? -100) - (a.signalStrength ?? -100))
    .map((shade) => shade.bleName)
    .filter(Boolean);

  if (bleNames.length === 0) {
    throw new GatewayError('None of the gateway\'s shades speak Bluetooth', 'no_ble_shades');
  }

  for (let pass = 0; pass < PASSES; pass++) {
    if (pass > 0) {
      log(`gateway key fetch pass ${pass} found nothing, retrying`);
      await sleep(PASS_DELAY_MS);
    }

    for (const bleName of bleNames) {
      let result;
      try {
        result = await request({
          host,
          path: `/home/shades/exec?shades=${encodeURIComponent(bleName)}`,
          method: 'POST',
          body: { hex: GET_SHADE_KEY_FRAME },
        });
      } catch (err) {
        log(`shade ${bleName} unreachable via the gateway: ${err.message}`);
        continue;
      }

      const key = parseKeyResponse(result);
      if (key) return key;
    }
  }

  throw new GatewayError('No shade on the gateway returned a key', 'no_key');
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reduce whatever the user typed to a bare host.
 *
 * People paste `http://powerview-g3.local/`, `192.168.1.10:80`, or just the
 * name; all three should work.
 *
 * @param {string} input
 * @returns {string}
 */
function normalizeHost(input) {
  if (typeof input !== 'string') return '';
  return input
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

module.exports = {
  GET_SHADE_KEY_FRAME,
  GatewayError,
  fetchHomeKey,
  normalizeHost,
  parseKeyResponse,
};
