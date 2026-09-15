'use strict';

/**
 * Answering a slow command before it has finished.
 *
 * Homey's capability listeners are the one place this app is called by
 * something with its own patience. A voice assistant reached through a bridge
 * - Apple Home via HomeKitty, say - turns "open the blinds" into a single
 * write and gives up on it in a few seconds, while a Bluetooth round trip to
 * a shade can take three times that. The command succeeds and the assistant
 * reports failure.
 *
 * The fix is to stop conflating "the command was accepted" with "the shade
 * has finished moving". Nothing is suppressed: a failure still reaches the
 * caller when it arrives in time, and `onFailure` sees every failure either
 * way, which is the only way a late one can be reported at all.
 */

/**
 * @param {Promise<unknown>} command The work already in flight.
 * @param {object} options
 * @param {number} options.ms How long to wait before answering anyway.
 * @param {(fn: () => void, ms: number) => unknown} options.setTimeout
 * @param {(timer: unknown) => void} options.clearTimeout
 * @param {(err: Error) => void} [options.onFailure] Every failure, early or
 *   late. A late one cannot be thrown, so this is where it goes.
 * @param {() => void} [options.onSlow] Called when the cap, not the command,
 *   is what answered.
 * @returns {Promise<void>} Rejects only if the command failed within `ms`.
 */
function answerWithin(command, {
  ms,
  setTimeout,
  clearTimeout,
  onFailure = () => {},
  onSlow = () => {},
}) {
  // Turning a rejection into a resolved value is what keeps a late failure
  // from becoming an unhandled rejection: by then the race below has settled
  // and there is nobody left to throw to.
  const outcome = command.then(
    () => null,
    (err) => {
      onFailure(err);
      return err;
    },
  );

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onSlow();
      resolve();
    }, ms);

    outcome.then((err) => {
      clearTimeout(timer);
      // Both are a no-op if the cap already answered.
      if (err) reject(err);
      else resolve();
    });
  });
}

module.exports = { answerWithin };
