// V2 scales into sustained buying using wallet-level flow and profit-taking risk.
import { createReadStream, createWriteStream } from 'node:fs';
import { runBot } from './vendor/makefun-bot.ts';
import { createBot } from './strategy.ts';

// Use the original descriptors for protocol I/O on the local process driver's pipes.
await runBot(createBot(), {
  input: createReadStream('', { fd: 0, autoClose: false }),
  output: createWriteStream('', { fd: 1, autoClose: false }),
});
