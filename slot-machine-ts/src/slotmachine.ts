import {
  type SlotConfig,
  type SpinResult,
  type SymbolDef,
  type SymbolId,
  type Wallet,
  type PayoutTable,
  type LineWin,
} from "./types";
import { type Rng, defaultRng } from "./rng";

export class SlotMachine {
  private config: SlotConfig;
  private wallet: Wallet;
  private rng: Rng;

  private cumulative: { id: SymbolId; cum: number }[];
  private totalWeight: number;

  constructor(config: SlotConfig, wallet: Wallet, rng: Rng = defaultRng) {
    if (config.reels <= 0 || config.rows <= 0)
      throw new Error("rows/reels must be > 0");
    if (config.symbols.length === 0) throw new Error("symbols required");

    this.config = config;
    this.wallet = wallet;
    this.rng = rng;

    this.totalWeight = config.symbols.reduce((acc, s) => acc + s.weight, 0);
    let running = 0;
    this.cumulative = config.symbols.map((s) => {
      running += s.weight;
      return { id: s.id, cum: running };
    });
  }

  getWallet(): Readonly<Wallet> {
    return { ...this.wallet };
  }

  setBetCents(newBet: number): void {
    if (!Number.isInteger(newBet) || newBet <= 0)
      throw new Error("Bet must be a positive integer (cents)");
    this.wallet.betCents = newBet;
  }

  addFunds(cents: number): void {
    if (!Number.isInteger(cents) || cents <= 0)
      throw new Error("Funds must be a positive integer (cents)");
    this.wallet.balanceCents += cents;
  }

  /** Spin: deduct bet, fill grid, score left-to-right H + diagonals (start at col 0), pay total. */
  spin(): SpinResult {
    if (this.wallet.betCents > this.wallet.balanceCents)
      throw new Error("Insufficient balance");

    this.wallet.balanceCents -= this.wallet.betCents;

    const grid: SymbolId[][] = [];
    for (let r = 0; r < this.config.rows; r++) {
      const row: SymbolId[] = [];
      for (let c = 0; c < this.config.reels; c++) {
        row.push(this.pickWeightedSymbol());
      }
      grid.push(row);
    }

    const lineWins: LineWin[] = [];
    let totalWinCents = 0;
    let anySevenJackpot = false;

    // ---------- Horizontal (start at col 0) ----------
    for (let r = 0; r < this.config.rows; r++) {
      const row = grid[r];
      const sym = row[0];
      let len = 1;
      for (let c = 1; c < this.config.reels; c++) {
        if (row[c] === sym) len++;
        else break;
      }
      if (len >= 3) {
        const clamped = (len >= 5 ? 5 : len) as 3 | 4 | 5;
        const mult = this.config.payoutTable[sym][clamped];
        const win = Math.floor(this.wallet.betCents * mult);
        if (win > 0) {
          lineWins.push({
            startRow: r,
            startCol: 0,
            endRow: r,
            endCol: clamped - 1,
            length: clamped,
            symbol: sym,
            winCents: win,
          });
          totalWinCents += win;
          if (sym === "SEVEN" && clamped === 5) anySevenJackpot = true;
        }
      }
    }

    // ---------- Diagonal DOWN-RIGHT (start at col 0, rows 0..rows-3) ----------
    for (let r0 = 0; r0 <= this.config.rows - 3; r0++) {
      const sym = grid[r0][0];
      let len = 1;
      let r = r0 + 1;
      let c = 1;
      while (
        r < this.config.rows &&
        c < this.config.reels &&
        grid[r][c] === sym
      ) {
        len++;
        r++;
        c++;
      }
      if (len >= 3) {
        const clamped = (len >= 5 ? 5 : len) as 3 | 4 | 5;
        const mult = this.config.payoutTable[sym][clamped];
        const win = Math.floor(this.wallet.betCents * mult);
        if (win > 0) {
          lineWins.push({
            startRow: r0,
            startCol: 0,
            endRow: r0 + (clamped - 1),
            endCol: clamped - 1,
            length: clamped,
            symbol: sym,
            winCents: win,
          });
          totalWinCents += win;
          if (sym === "SEVEN" && clamped === 5) anySevenJackpot = true;
        }
      }
    }

    // ---------- Diagonal UP-RIGHT (start at col 0, rows 2..rows-1) ----------
    for (let r0 = 2; r0 < this.config.rows; r0++) {
      const sym = grid[r0][0];
      let len = 1;
      let r = r0 - 1;
      let c = 1;
      while (r >= 0 && c < this.config.reels && grid[r][c] === sym) {
        len++;
        r--;
        c++;
      }
      if (len >= 3) {
        const clamped = (len >= 5 ? 5 : len) as 3 | 4 | 5;
        const mult = this.config.payoutTable[sym][clamped];
        const win = Math.floor(this.wallet.betCents * mult);
        if (win > 0) {
          lineWins.push({
            startRow: r0,
            startCol: 0,
            endRow: r0 - (clamped - 1),
            endCol: clamped - 1,
            length: clamped,
            symbol: sym,
            winCents: win,
          });
          totalWinCents += win;
          if (sym === "SEVEN" && clamped === 5) anySevenJackpot = true;
        }
      }
    }

    this.wallet.balanceCents += totalWinCents;

    return {
      grid,
      totalWinCents,
      lineWins,
      isJackpot: anySevenJackpot,
    };
  }

  private pickWeightedSymbol(): SymbolId {
    const r = this.rng.next() * this.totalWeight;
    for (const e of this.cumulative) {
      if (r < e.cum) return e.id;
    }
    return this.cumulative[this.cumulative.length - 1].id;
  }
}

/* ---------- Default config for 5x5 ---------- */

export const DEFAULT_SYMBOLS: SymbolDef[] = [
  { id: "CHERRY", emoji: "🍒", weight: 40 },
  { id: "LEMON", emoji: "🍋", weight: 30 },
  { id: "STAR", emoji: "⭐", weight: 20 },
  { id: "SEVEN", emoji: "7️⃣", weight: 10 },
];

/** Multipliers per run length (applied to the bet). Tune to taste. */
export const DEFAULT_PAYOUT: PayoutTable = {
  CHERRY: { 3: 1.5, 4: 3, 5: 6 },
  LEMON: { 3: 2, 4: 4, 5: 8 },
  STAR: { 3: 3, 4: 6, 5: 12 },
  SEVEN: { 3: 5, 4: 12, 5: 25 },
};

export const DEFAULT_CONFIG: SlotConfig = {
  reels: 5,
  rows: 5,
  symbols: DEFAULT_SYMBOLS,
  payoutTable: DEFAULT_PAYOUT,
};

export function createDefaultMachine(
  initialBalanceCents = 10000,
  initialBetCents = 100
) {
  return new SlotMachine(DEFAULT_CONFIG, {
    balanceCents: initialBalanceCents,
    betCents: initialBetCents,
  });
}
