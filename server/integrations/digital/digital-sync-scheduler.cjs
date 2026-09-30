const { digitalOptions } = require("./sigi-config.cjs");

function prepareDigitalSyncScheduler({ options = digitalOptions(), run,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
  timeoutMs = options.timeoutMs ?? 120000, onResult = () => {} } = {}) {
  if (typeof run !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000)
    throw new Error("DIGITAL_CONFIG_ERROR");
  let running = false;
  let timer = null;
  let nextDueAt = null;
  let activeObserved = null;
  const emit = (value) => { try { onResult(value); } catch { /* Monitoring cannot stop the API. */ } };
  async function runOnce() {
    if (running) return { skipped: "DIGITAL_SYNC_BUSY" };
    running = true;
    let watchdog;
    const task = Promise.resolve().then(run);
    const observed = task.then((result) => ({ ok: true, result }),
      () => ({ ok: false, reason: "DIGITAL_SYNC_FAILED" }));
    activeObserved = observed;
    const deadline = new Promise((resolve) => {
      watchdog = setTimeoutImpl(() => resolve({ ok: false, reason: "DIGITAL_SYNC_TIMEOUT" }), timeoutMs);
    });
    const outcome = await Promise.race([observed, deadline]);
    clearTimeoutImpl(watchdog);
    if (outcome.reason === "DIGITAL_SYNC_TIMEOUT") {
      // An HTTP timeout must be enforced by the client; retain the lock until its promise settles.
      void observed.then(() => { running = false; activeObserved = null; });
    } else { running = false; activeObserved = null; }
    emit(outcome);
    return outcome;
  }
  function start() {
    if (!options.enabled || timer) return false;
    const intervalMs = options.intervalMinutes * 60000;
    nextDueAt = new Date(Date.now() + intervalMs).toISOString();
    timer = setIntervalImpl(() => {
      nextDueAt = new Date(Date.now() + intervalMs).toISOString();
      void runOnce();
    }, intervalMs);
    return true;
  }
  function stop() { if (timer) clearIntervalImpl(timer); timer = null; nextDueAt = null; }
  async function stopAndDrain() { stop(); if (activeObserved) await activeObserved; }
  return { start, stop, stopAndDrain, runOnce, isRunning: () => running,
    isScheduled: () => timer !== null, nextDueAt: () => nextDueAt };
}

module.exports = { prepareDigitalSyncScheduler };
