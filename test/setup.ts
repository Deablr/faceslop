// node:sqlite logs an ExperimentalWarning on Node 22; keep test output readable (same filter as
// src/server/node-server.ts).
const previous = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
  if (previous.length === 0) console.warn(warning);
  for (const listener of previous) listener.call(process, warning);
});
