// V4 caps each strategy mint at 3.50 SOL and rechecks add-ons on every eligible reply for 64 slots.
import { createReadStream, createWriteStream } from 'node:fs';
import { runBot } from './vendor/makefun-bot.ts';
import { createBot } from './strategy.ts';

// Use the original descriptors for protocol I/O on the local process driver's pipes.
await runBot(createBot(), {
  input: createReadStream('', { fd: 0, autoClose: false }),
  output: createWriteStream('', { fd: 1, autoClose: false }),
});
