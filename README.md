# Pump Paper Bot

[![make.fun competition](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![make.fun rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/mochiko28/pump-paper-bot/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![make.fun reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/mochiko28/pump-paper-bot/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

V2 is a deterministic TypeScript paper-trading bot for the make.fun Pump.fun Replay Sprint. It reconstructs wallet inventory and fee-inclusive average buy costs from recorded trades, then looks for continued buying with limited selling pressure.

## Run locally

From the unpacked competition kit, run the local grader against your checkout. The entrypoint is `main.ts` and uses the vendored replay SDK. Node.js 22.18 or later runs the TypeScript directly without a build or install step.

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/pump-paper-bot --driver docker
```

Add `--worktree` to grade uncommitted files. For a quick protocol check, the harness can also launch the bot directly with `node main.ts` and communicate over stdin and stdout.

## Strategy

Reserve bands include the lower bound and exclude the upper bound. Net buying uses the most recent 50 slots, including the decision slot.

| Real quote reserves | Entry conditions |
| --- | --- |
| 20–30 SOL | Net buying of at least 15 SOL and early overhang below 20%. |
| 30–50 SOL | The same early-overhang setup, or net buying of at least 10 SOL with both dump-loss limits and dispersed buying. |
| 50–65 SOL | Net buying of at least 8 SOL, with early overhang below 20% or a reserve-adjusted cost-to-spot ratio in `[1.4, 1.6)`. |

Early overhang is the estimated sell proceeds of profitable wallets among the first ten distinct buyers, as a share of real quote reserves. The dispersed setup requires the largest net buyer to contribute less than 35% of positive wallet net flow. The simulated spot drop must be below 25% for a sale by the largest holder and below 70% for a combined sale by wallets holding at a gain of at least 50%.

Each strategy position can build up to 2.75 SOL. During the first 64 slots after the first fill, add-ons require a fresh batch with positive net buying and a valid entry signal. Each buy respects the 1% real-reserve order cap. Exits use the recorded spot at the first fill as the reference. The bot exits after 240 slots, at a 20% loss, or on a 25% trailing drawdown once the price has gained 30%.

One-at-a-time qualification probes buy 0.012 SOL on positive-flow batches with 1.3–8 SOL in real reserves and seek a full exit at the first opportunity at least one slot after the buy fill. The probe program targets 22 distinct qualifying mints, counting strategy round trips.
