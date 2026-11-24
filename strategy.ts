import { BPS, type Bot, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';
import { OwnershipBook, type OwnershipSignal } from './ownership.ts';

const POSITION_BUDGET = 2_750_000_000n;
const ADD_MINIMUM = 50_000_000n;
const BUILD_SLOTS = 64;
const HOLD_SLOTS = 240;
const SPOT_STOP_LOSS = 0.30;
const TRAIL_ARM_GAIN = 0.40;
const TRAILING_STOP_LOSS = 0.35;
const QUALIFYING_SPEND = 10_000_000n;
const PROBE_SIZE = 12_000_000n;
const QUALIFYING_TARGET = 22;

interface Trade {
  kind: 'strategy' | 'probe';
  spent: bigint;
  firstFill?: { slot: number; spot: number };
  highRatio: number;
  exit: boolean;
}

function shouldEnter(signal: OwnershipSignal): boolean {
  const { reserveSol, flowSol, earlyOverhang, exhaustion, topFlowShare } = signal;
  if (reserveSol >= 20 && reserveSol < 30) {
    return flowSol >= 15 && earlyOverhang < 0.20;
  }
  if (reserveSol >= 30 && reserveSol < 50) {
    if (flowSol >= 15 && earlyOverhang < 0.20) return true;
    return flowSol >= 10 && signal.largestDumpLossPct < 25
      && topFlowShare !== null && topFlowShare < 0.35 && signal.profitDumpLossPct < 70;
  }
  return reserveSol >= 50 && reserveSol < 65 && flowSol >= 8
    && (earlyOverhang < 0.20 || (exhaustion !== null && exhaustion >= 1.4 && exhaustion < 1.6));
}

export function createBot(): Bot {
  const books = new Map<Pubkey, OwnershipBook>();
  const trades = new Map<Pubkey, Trade>();
  const traded = new Set<Pubkey>();
  const qualified = new Set<Pubkey>();
  const reserveImpact = new Map<Pubkey, bigint>();

  return {
    onBatch(state, batch) {
      const { slot } = batch;
      const changed = new Set<Pubkey>();
      for (const event of batch.events) {
        if (event.event === 'CreateEvent') {
          books.set(event.mint, new OwnershipBook());
        } else if (event.event === 'TradeEvent') {
          books.get(event.mint)!.record(event);
          changed.add(event.mint);
        }
      }

      for (const fill of batch.fills) {
        if (fill.status !== 'filled') continue;
        const { mint } = fill;
        const quote = BigInt(fill.quote_lamports);
        const fee = BigInt(fill.fee_lamports);
        const impact = fill.side === 'buy' ? quote - fee : -(quote + fee);
        reserveImpact.set(mint, (reserveImpact.get(mint) ?? 0n) + impact);

        const trade = trades.get(mint);
        if (trade === undefined) continue;
        if (fill.side === 'buy') {
          trade.firstFill ??= { slot: fill.slot, spot: books.get(mint)!.spot };
          trade.spent += quote;
        } else if (!state.positions.has(mint) && trade.spent >= QUALIFYING_SPEND) {
          qualified.add(mint);
        }
      }

      const pending = new Set<Pubkey>();
      for (const { order } of state.pending.values()) pending.add(order.mint);
      const marks = new Map(batch.marks.map(mark => [mark.mint, mark]));
      const caps = state.hello.caps;
      const txFee = state.txFeeLamports();
      const orders: OrderInput[] = [];
      let cash = state.freeCashLamports();

      function buy(mint: Pubkey, target: bigint, minimum: bigint): boolean {
        const mark = marks.get(mint);
        // Batch marks already include our fills. A recorded reserve needs the net fill impact.
        const reserve = mark === undefined
          ? state.curves.get(mint)!.real_quote_reserves + (reserveImpact.get(mint) ?? 0n)
          : BigInt(mark.real_quote_reserves);
        const cap = reserve * BigInt(caps.max_order_bps_of_real_reserve) / BPS;
        const available = cash - 10n * txFee;
        let amount = target < cap ? target : cap;
        if (amount > available) amount = available;
        if (amount < minimum || orders.length >= caps.max_orders_per_batch) return false;

        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: 10_000 });
        cash -= amount + txFee;
        return true;
      }

      // Preserve position insertion order and manage existing trades before opening new ones.
      for (const [mint, trade] of trades) {
        const holding = state.positions.get(mint);
        const awaitingFill = pending.has(mint);
        if (holding === undefined) {
          if (!awaitingFill) {
            if (trade.kind === 'strategy' && trade.spent > 0n) traded.add(mint);
            trades.delete(mint);
          }
          continue;
        }
        if (trade.firstFill === undefined || state.curves.get(mint)!.complete) continue;

        const book = books.get(mint)!;
        const age = slot - trade.firstFill.slot;
        const ratio = book.spot / trade.firstFill.spot;
        trade.highRatio = Math.max(trade.highRatio, ratio);
        trade.exit ||= trade.kind === 'probe'
          ? age >= 1
          : age >= HOLD_SLOTS || ratio <= 1 - SPOT_STOP_LOSS
            || (trade.highRatio >= 1 + TRAIL_ARM_GAIN && ratio <= trade.highRatio * (1 - TRAILING_STOP_LOSS));

        if (awaitingFill) continue;
        if (trade.exit) {
          if (cash < txFee || orders.length >= caps.max_orders_per_batch) continue;
          orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: 10_000 });
          cash -= txFee;
        } else if (trade.kind === 'strategy' && age < BUILD_SLOTS && changed.has(mint)) {
          const signal = book.signal(slot);
          if (signal.slotFlowSol > 0 && shouldEnter(signal)) {
            buy(mint, POSITION_BUDGET - trade.spent, ADD_MINIMUM);
          }
        }
      }

      const candidates = [...changed].filter(mint => !trades.has(mint) && !state.curves.get(mint)!.complete);
      for (const mint of candidates) {
        if (trades.size >= caps.max_open_positions) break;
        const book = books.get(mint)!;
        if (traded.has(mint) || book.reserveSol < 15 || !shouldEnter(book.signal(slot))) continue;
        if (buy(mint, POSITION_BUDGET, PROBE_SIZE)) {
          trades.set(mint, { kind: 'strategy', spent: 0n, highRatio: 0, exit: false });
        }
      }

      if (trades.size < caps.max_open_positions && qualified.size < QUALIFYING_TARGET
          && ![...trades.values()].some(trade => trade.kind === 'probe')) {
        for (const mint of candidates) {
          const book = books.get(mint)!;
          if (trades.has(mint) || qualified.has(mint) || book.reserveSol < 1.3 || book.reserveSol > 8) continue;
          if (book.signal(slot).slotFlowSol > 0 && buy(mint, PROBE_SIZE, PROBE_SIZE)) {
            trades.set(mint, { kind: 'probe', spent: 0n, highRatio: 0, exit: false });
            break;
          }
        }
      }

      return orders;
    },
  };
}
