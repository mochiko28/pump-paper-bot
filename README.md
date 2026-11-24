# Pump Paper Bot

[![make.fun competition](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![make.fun rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/mochiko28/pump-paper-bot/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![make.fun reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/mochiko28/pump-paper-bot/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A deterministic TypeScript paper-trading bot for the make.fun Pump.fun Replay Sprint.

## Run locally

From the unpacked competition kit, run the local grader against your checkout. The entrypoint is `main.ts` and uses the vendored replay SDK. Node.js 22.18 or later runs the TypeScript directly without a build or install step.

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/pump-paper-bot --driver docker
```

Add `--worktree` to grade uncommitted files. For a quick protocol check, the harness can also launch the bot directly with `node main.ts` and communicate over stdin and stdout.

## Strategy

- Qualification probes buy 0.012 SOL on young curves with 2–20 SOL in real quote reserves and at least eight recorded trades. They close after 30 slots or a 10% move in either direction, with up to two probes outstanding and a target of 24 distinct qualifying round trips.
- The completion rider enters when a curve crosses 65 SOL in real quote reserves and its 30-slot net recorded flow is positive. It adds each batch within the order cap, a 45% per-mint equity limit, a 0.5 SOL cash floor, and a maximum of three rider positions. It holds for the replay engine's completion close, with full exits below 50 SOL in real reserves or 25% below average entry.
- A portfolio cash reserve of half the highest observed equity plus exit fees limits new spending under the competition's 50% drawdown guardrail.
