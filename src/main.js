import { createApp } from './create-app.js';

const app = await createApp();
await app.start();

async function shutdown() {
  await app.stop({ waitMs: 30_000 });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
