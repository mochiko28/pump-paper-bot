// V3 arms the trail at a 40% gain, with a 35% trailing stop and a 30% spot stop.
import { createReadStream, createWriteStream } from 'node:fs';
import { runBot } from './vendor/makefun-bot.ts';
import { createBot } from './strategy.ts';

// Use the original descriptors for protocol I/O on the local process driver's pipes.
await runBot(createBot(), {
  input: createReadStream('', { fd: 0, autoClose: false }),
  output: createWriteStream('', { fd: 1, autoClose: false }),
});
