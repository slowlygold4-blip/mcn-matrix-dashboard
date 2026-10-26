import { parentPort, workerData } from 'node:worker_threads';

// Entirely offline lifecycle fixture. The actual audit worker is exercised
// separately against a small temporary SQLite database and backup.
parentPort.on('message', job => {
  if (workerData.mode === 'throw') throw new Error('PRIVATE_SENTINEL should never escape a worker failure');
  if (workerData.mode === 'exit') process.exit(0);
  if (workerData.mode === 'hang') return;
  if (workerData.mode === 'error-message') {
    parentPort.postMessage({ id: job.id, ok: false, code: 'PRIVATE_SENTINEL', error: 'PRIVATE_SENTINEL' }); return;
  }
  if (workerData.mode === 'cpu') {
    const until = Date.now() + 250;
    while (Date.now() < until) { /* Deliberately busy only in the fixture worker. */ }
  }
  parentPort.postMessage({ id: job.id, ok: true, result: {
    database: { status: 'ok', marker: workerData.marker || 'fresh' }, backup: { status: 'ok' },
    checkStartedAt: new Date().toISOString(), checkFinishedAt: new Date().toISOString(),
  } });
});
