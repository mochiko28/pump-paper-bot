// V6 extends the 240-slot time stop in 60-slot steps up to 720 slots while 50-slot net flow is at least 3 SOL.
import { createReadStream, createWriteStream } from 'node:fs';
import { runBot } from './vendor/makefun-bot.ts';
import { createBot } from './strategy.ts';

// Use the original descriptors for protocol I/O on the local process driver's pipes.
await runBot(createBot(), {
  input: createReadStream('', { fd: 0, autoClose: false }),
  output: createWriteStream('', { fd: 1, autoClose: false }),
});
