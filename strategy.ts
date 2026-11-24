import {
  BPS,
  LAMPORTS_PER_SOL as SOL,
  type Batch,
  type Bot,
  type BotState,
  type Curve,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const PROBE_SIZE = 12_000_000n;
const MIN_QUALIFYING_SPEND = 10_000_000n;
const QUALIFYING_TARGET = 24;
const PROBE_MAX_AGE = 300;
const PROBE_HOLD_SLOTS = 30;
const FLOW_SLOTS = 30;
const RIDER_ENTRY = 65n * SOL;
const RIDER_STOP = 50n * SOL;
const CASH_FLOOR = SOL / 2n;
const CAP_MARGIN = 10_000n;

interface Market {
  rq: bigint;
  netFlow: bigint;
  flow: { slot: number; amount: bigint }[];
  protocolFeeBps: bigint;
  creatorFeeBps: bigint;
  riderSignal: boolean;
}

interface Trade {
  kind: 'probe' | 'rider';
  openedSlot: number | null;
  bought: bigint;
  qualifies: boolean;
  exiting: boolean;
}

const min = (a: bigint, b: bigint) => a < b ? a : b;
const max = (a: bigint, b: bigint) => a > b ? a : b;

function sellValue(curve: Curve, tokens: bigint): bigint {
  return tokens * curve.virtual_quote_reserves / (curve.virtual_token_reserves + tokens);
}

export function createBot(): Required<Pick<Bot, 'onHello' | 'onBatch'>> {
  const markets = new Map<Pubkey, Market>();
  const trades = new Map<Pubkey, Trade>();
  const qualified = new Set<Pubkey>();
  const quoteOffsets = new Map<Pubkey, bigint>();
  let txFee = 0n;
  let protocolFee = 0n;
  let creatorFee = 0n;
  let peakEquity = 0n;

  function applyFills(batch: Batch) {
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;

      const quote = BigInt(fill.quote_lamports);
      const fee = BigInt(fill.fee_lamports);
      const offset = quoteOffsets.get(fill.mint) ?? 0n;
      quoteOffsets.set(fill.mint, offset + (fill.side === 'buy' ? quote - fee : -quote - fee));

      const trade = trades.get(fill.mint);
      if (trade === undefined) continue;
      if (fill.side === 'buy') {
        trade.openedSlot ??= fill.slot;
        trade.bought += quote;
        trade.qualifies = trade.kind === 'probe'
          ? quote >= MIN_QUALIFYING_SPEND && quote - fee >= MIN_QUALIFYING_SPEND
          : trade.bought >= MIN_QUALIFYING_SPEND;
      } else if (!batch.account.positions.some(position => position.mint === fill.mint)) {
        if (trade.qualifies) qualified.add(fill.mint);
        trades.delete(fill.mint);
      }
    }
  }

  function updateMarkets(state: BotState, batch: Batch): Set<Pubkey> {
    const flowByMint = new Map<Pubkey, bigint>();
    for (const event of batch.events) {
      if (event.event !== 'TradeEvent') continue;
      const amount = BigInt(event.quote_amount);
      const flow = flowByMint.get(event.mint) ?? 0n;
      flowByMint.set(event.mint, flow + (event.is_buy ? amount : -amount));

      const market = markets.get(event.mint) ?? {
        rq: 0n, netFlow: 0n, flow: [], protocolFeeBps: protocolFee,
        creatorFeeBps: creatorFee, riderSignal: false,
      };
      const recordedFee = BigInt(event.fee_basis_points);
      market.protocolFeeBps = recordedFee > 0n ? recordedFee : protocolFee;
      market.creatorFeeBps = recordedFee > 0n ? BigInt(event.creator_fee_basis_points) : creatorFee;
      markets.set(event.mint, market);
    }

    const marked = new Set<Pubkey>();
    for (const mark of batch.marks) {
      const curve = state.curves.get(mark.mint);
      if (curve === undefined || mark.slot < curve.reserves_slot) continue;
      // SDK events can overwrite marks in the same slot. Marks include our fills.
      curve.real_quote_reserves = BigInt(mark.real_quote_reserves);
      curve.virtual_quote_reserves = BigInt(mark.virtual_quote_reserves);
      curve.real_token_reserves = BigInt(mark.real_token_reserves);
      curve.virtual_token_reserves = BigInt(mark.virtual_token_reserves);
      curve.reserves_slot = mark.slot;
      marked.add(mark.mint);
    }

    const updated = new Set([...flowByMint.keys(), ...marked]);
    for (const mint of updated) {
      const market = markets.get(mint);
      const curve = state.curves.get(mint);
      if (market === undefined || curve === undefined || curve.complete) continue;
      if (!marked.has(mint)) {
        // Once flat, only the net quote impact can persist and the harness stops sending marks.
        const offset = max(-curve.real_quote_reserves, quoteOffsets.get(mint) ?? 0n);
        curve.real_quote_reserves += offset;
        curve.virtual_quote_reserves += offset;
      }

      const amount = flowByMint.get(mint) ?? 0n;
      if (amount !== 0n) {
        market.flow.push({ slot: batch.slot, amount });
        market.netFlow += amount;
      }
      while (market.flow.length > 0 && market.flow[0].slot <= batch.slot - FLOW_SLOTS) {
        market.netFlow -= market.flow.shift()!.amount;
      }

      const rq = curve.real_quote_reserves;
      if (rq < RIDER_ENTRY) market.riderSignal = false;
      else if (market.rq < RIDER_ENTRY) market.riderSignal = market.netFlow > 0n;
      market.rq = rq;
    }
    return updated;
  }

  return {
    onHello(state) {
      txFee = state.txFeeLamports();
      protocolFee = BigInt(state.hello.fees.protocol_bps_fallback);
      creatorFee = BigInt(state.hello.fees.creator_bps_fallback);
      peakEquity = state.cash;
    },

    onBatch(state, batch) {
      applyFills(batch);
      const updated = updateMarkets(state, batch);
      const pendingBuys = new Map<Pubkey, bigint>();
      const pendingSells = new Set<Pubkey>();
      for (const { order } of state.pending.values()) {
        if (order.side === 'sell') pendingSells.add(order.mint);
        else {
          const committed = (pendingBuys.get(order.mint) ?? 0n) + BigInt(order.quote_lamports) + txFee;
          pendingBuys.set(order.mint, committed);
        }
      }

      for (const [mint] of trades) {
        if (!state.positions.has(mint) && !pendingBuys.has(mint)) trades.delete(mint);
      }

      let equity = state.cash;
      const exposure = new Map<Pubkey, bigint>();
      const liquidationQuotes = new Map<Pubkey, bigint>();
      for (const [mint, holding] of state.positions) {
        const curve = state.curves.get(mint)!;
        const market = markets.get(mint);
        const gross = sellValue(curve, holding.token_amount);
        liquidationQuotes.set(mint, gross);
        const capped = min(gross, curve.real_quote_reserves);
        const fee = (bps: bigint) => (capped * bps + BPS - 1n) / BPS;
        const net = capped - fee(market?.protocolFeeBps ?? protocolFee)
          - fee(market?.creatorFeeBps ?? creatorFee) - txFee;
        equity += max(0n, net);
        exposure.set(mint, max(holding.cost_lamports, capped));
      }

      const orders: OrderInput[] = [];
      const caps = state.hello.caps;
      const hasOrderRoom = () => orders.length < caps.max_orders_per_batch;
      // Keep half of peak equity in cash in case the positions gap through their stops.
      peakEquity = max(peakEquity, equity);
      const cashReserve = max(CASH_FLOOR, (peakEquity + 1n) / 2n
        + BigInt(caps.max_open_positions) * txFee);
      let freeCash = state.freeCashLamports();
      let riders = 0;
      let probes = 0;

      for (const [mint, trade] of trades) {
        if (trade.kind === 'probe') probes++;
        else riders++;

        const curve = state.curves.get(mint)!;
        const holding = state.positions.get(mint);
        if (holding === undefined || curve.complete) continue;

        // Compare the marginal curve price with the average paid price using integer ratios.
        const current = curve.virtual_quote_reserves * holding.token_amount * 100n;
        const entry = curve.virtual_token_reserves * holding.cost_lamports;
        if (trade.kind === 'probe') {
          trade.exiting ||= batch.slot - trade.openedSlot! >= PROBE_HOLD_SLOTS
            || current <= entry * 90n || current >= entry * 110n;
        } else {
          trade.exiting ||= curve.real_quote_reserves < RIDER_STOP || current <= entry * 75n;
          if (trade.exiting) markets.get(mint)!.riderSignal = false;
        }

        if (trade.exiting && !pendingSells.has(mint) && !pendingBuys.has(mint)
            && hasOrderRoom() && freeCash >= txFee
            && liquidationQuotes.get(mint)! <= curve.real_quote_reserves) {
          orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: 5000 });
          freeCash -= txFee;
        }
      }

      function buy(mint: Pubkey, size: bigint, kind: Trade['kind']) {
        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: 2000 });
        freeCash -= size + txFee;
        if (!trades.has(mint)) {
          trades.set(mint, { kind, openedSlot: null, bought: 0n, qualifies: false, exiting: false });
        }
      }

      function addRider(mint: Pubkey): boolean {
        if (!hasOrderRoom()) return false;
        const cap = state.maxBuyLamports(mint) - CAP_MARGIN;
        const room = equity * 45n / 100n - (exposure.get(mint) ?? 0n) - (pendingBuys.get(mint) ?? 0n);
        const size = min(cap, min(room, freeCash - cashReserve) - txFee);
        if (size <= txFee) return false;
        buy(mint, size, 'rider');
        return true;
      }

      for (const [mint, trade] of trades) {
        if (trade.kind === 'rider' && !trade.exiting) addRider(mint);
      }
      for (const mint of updated) {
        if (riders >= 3 || trades.size >= caps.max_open_positions || !hasOrderRoom()) break;
        const curve = state.curves.get(mint)!;
        const market = markets.get(mint);
        if (curve.complete || trades.has(mint) || !market?.riderSignal || market.netFlow <= 0n) continue;
        if (addRider(mint)) riders++;
      }

      for (const mint of updated) {
        if (probes >= 2 || qualified.size + probes >= QUALIFYING_TARGET
            || trades.size >= caps.max_open_positions || !hasOrderRoom()
            || freeCash < cashReserve + PROBE_SIZE + txFee) break;
        const curve = state.curves.get(mint)!;
        if (trades.has(mint) || qualified.has(mint) || curve.complete || curve.trades < 8
            || curve.created_slot === null || batch.slot - curve.created_slot > PROBE_MAX_AGE
            || curve.real_quote_reserves < 2n * SOL || curve.real_quote_reserves > 20n * SOL
            || state.maxBuyLamports(mint) < PROBE_SIZE) continue;
        buy(mint, PROBE_SIZE, 'probe');
        probes++;
      }
      return orders;
    },
  };
}
