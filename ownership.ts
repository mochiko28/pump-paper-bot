import { LAMPORTS_PER_SOL, type Pubkey, type TradeEventRecord } from './vendor/makefun-bot.ts';

const SOL = Number(LAMPORTS_PER_SOL);
const FLOW_SLOTS = 50;

interface Inventory {
  tokens: number;
  costSol: number;
}

interface TradeFlow {
  slot: number;
  wallet: Pubkey;
  signedLamports: number;
}

export class OwnershipBook {
  #inventory = new Map<Pubkey, Inventory>();
  #earlyBuyers = new Set<Pubkey>();
  #recentTrades: TradeFlow[] = [];
  #virtualQuote = 0;
  #virtualTokens = 0;
  reserveSol = 0;
  spot = 0;

  record(trade: TradeEventRecord): void {
    const wallet = trade.user;
    const tokens = Number(trade.token_amount);
    const lamports = Number(trade.quote_amount);
    const holding = this.#inventory.get(wallet) ?? { tokens: 0, costSol: 0 };
    const previousPositive = Math.max(0, holding.tokens);

    if (trade.is_buy) {
      if (this.#earlyBuyers.size < 10) this.#earlyBuyers.add(wallet);
      holding.tokens += tokens;
      const buyCost = lamports / SOL + (Number(trade.fee) + Number(trade.creator_fee)) / SOL;
      // Any tokens that cover an earlier inventory deficit carry no remaining cost.
      holding.costSol += buyCost * (Math.max(0, holding.tokens) - previousPositive) / (tokens || 1);
    } else {
      holding.tokens -= tokens;
      holding.costSol = holding.tokens > 0 ? holding.costSol * holding.tokens / previousPositive : 0;
    }
    this.#inventory.set(wallet, holding);

    this.#virtualQuote = Number(trade.virtual_quote_reserves) / SOL;
    this.#virtualTokens = Number(trade.virtual_token_reserves);
    this.reserveSol = Number(trade.real_quote_reserves) / SOL;
    this.spot = this.#virtualQuote / this.#virtualTokens;

    this.#recentTrades.push({
      slot: trade.slot,
      wallet,
      signedLamports: trade.is_buy ? lamports : -lamports,
    });
    let expired = 0;
    while (expired < this.#recentTrades.length && this.#recentTrades[expired].slot <= trade.slot - FLOW_SLOTS) {
      expired++;
    }
    if (expired > 0) this.#recentTrades.splice(0, expired);
  }

  #dumpLossPct(tokens: number): number {
    if (this.#virtualTokens <= 0) return 0;
    return 100 * (1 - (this.#virtualTokens / (this.#virtualTokens + tokens)) ** 2);
  }

  signal(slot: number) {
    // Sum inventory in descending balance order, retaining first-seen order at ties.
    const holders = [...this.#inventory].filter(([, holding]) => holding.tokens > 0);
    holders.sort((a, b) => b[1].tokens - a[1].tokens);
    let tokens = 0;
    let costSol = 0;
    let earlyProfitableTokens = 0;
    let profitDumpTokens = 0;
    for (const [wallet, holding] of holders) {
      tokens += holding.tokens;
      costSol += holding.costSol;
      const value = holding.tokens * this.spot;
      if (value > holding.costSol) {
        if (this.#earlyBuyers.has(wallet)) earlyProfitableTokens += holding.tokens;
        if (value >= 1.5 * holding.costSol) profitDumpTokens += holding.tokens;
      }
    }

    let slotFlowSol = 0;
    let netLamports = 0;
    const walletFlows = new Map<Pubkey, number>();
    for (const trade of this.#recentTrades) {
      if (trade.slot <= slot - FLOW_SLOTS) continue;
      netLamports += trade.signedLamports;
      walletFlows.set(trade.wallet, (walletFlows.get(trade.wallet) ?? 0) + trade.signedLamports);
      if (trade.slot === slot) slotFlowSol += trade.signedLamports / SOL;
    }
    let positiveFlow = 0;
    let topWalletFlow = 0;
    for (const flow of walletFlows.values()) {
      if (flow <= 0) continue;
      positiveFlow += flow;
      topWalletFlow = Math.max(topWalletFlow, flow);
    }

    const reserveSol = this.reserveSol;
    const earlySaleSol = earlyProfitableTokens * this.#virtualQuote
      / (this.#virtualTokens + earlyProfitableTokens);
    return {
      reserveSol,
      flowSol: netLamports / SOL,
      slotFlowSol,
      topFlowShare: positiveFlow > 0 ? topWalletFlow / positiveFlow : null,
      earlyOverhang: reserveSol > 0 ? Math.min(reserveSol, earlySaleSol) / reserveSol : 0,
      largestDumpLossPct: this.#dumpLossPct(holders[0]?.[1].tokens ?? 0),
      profitDumpLossPct: this.#dumpLossPct(profitDumpTokens),
      exhaustion: tokens > 0 && this.spot > 0
        ? (costSol / tokens / this.spot) * (30 + reserveSol) / 30 : null,
    };
  }
}

export type OwnershipSignal = ReturnType<OwnershipBook['signal']>;
