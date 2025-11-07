import {
  type SlotConfig,
  type SpinResult,
  type SymbolDef,
  type SymbolId,
  type Wallet,
  type PayoutTable,
  type LineWin,
  type ScoredGrid,
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

  /** Base game spin: deduct bet, generate, score (rows + diagonals), trigger FS on scatters. */
  spin(): SpinResult {
    if (this.wallet.betCents > this.wallet.balanceCents)
      throw new Error("Insufficient balance");

    this.wallet.balanceCents -= this.wallet.betCents;

    const grid = this.generateGrid();

    // base scoring (no wilds in base game)
    const scored = this.scoreGrid(grid, this.wallet.betCents, undefined);

    // Add winnings immediately for base
    this.wallet.balanceCents += scored.totalWinCents;

    // Scatter trigger (FS symbols count anywhere)
    const scatterCount = this.countScatters(grid);
    const freeSpinsAwarded =
      scatterCount >= 5
        ? 10
        : scatterCount === 4
        ? 8
        : scatterCount === 3
        ? 5
        : 0;

    return {
      grid,
      totalWinCents: scored.totalWinCents,
      lineWins: scored.lineWins,
      isJackpot: scored.isJackpot,
      freeSpinsAwarded,
    };
  }

  /** Generate a fresh rows×reels grid using weighted symbols. */
  generateGrid(): SymbolId[][] {
    const grid: SymbolId[][] = [];
    for (let r = 0; r < this.config.rows; r++) {
      const row: SymbolId[] = [];
      for (let c = 0; c < this.config.reels; c++) {
        row.push(this.pickWeightedSymbol());
      }
      grid.push(row);
    }
    return grid;
  }

  /**
   * Score grid with left-to-right rules:
   * - Horizontal (start at col 0)
   * - Diagonal down-right (start col 0)
   * - Diagonal up-right (start col 0)
   * Wild multipliers (if provided) are overlayed: any wild cell matches target symbol
   * and multiplies the line payout by its multiplier (stacking).
   */
  scoreGrid(
    grid: SymbolId[][],
    betCents: number,
    wilds?: number[][]
  ): ScoredGrid {
    const lineWins: LineWin[] = [];
    let totalWinCents = 0;
    let anySevenJackpot = false;

    const R = this.config.rows;
    const C = this.config.reels;

    const scoreRun = (r0: number, c0: number, dr: number, dc: number) => {
      // Find target symbol (first non-wild along the path)
      let r = r0,
        c = c0;
      let target: SymbolId | null = null;
      for (let k = 0; k < 5 && r >= 0 && r < R && c >= 0 && c < C; k++) {
        const sym = grid[r][c];
        const isWild = wilds && wilds[r][c] > 0;
        if (!isWild) {
          target = sym;
          break;
        }
        r += dr;
        c += dc;
      }
      if (!target) return; // all-wild leading segment → skip (or pick best symbol; we keep simple)

      // Count run length where cells are target or wild
      r = r0;
      c = c0;
      let len = 0;
      let productMult = 1; // line multiplier from wilds
      for (let k = 0; k < 5 && r >= 0 && r < R && c >= 0 && c < C; k++) {
        const sym = grid[r][c];
        const w = wilds ? wilds[r][c] | 0 : 0;
        if (sym === target || w > 0) {
          len++;
          if (w > 0) productMult *= w;
          r += dr;
          c += dc;
        } else {
          break;
        }
      }

      if (len >= 3) {
        const clamped = (len >= 5 ? 5 : len) as 3 | 4 | 5;
        const baseMult = this.config.payoutTable[target][clamped];
        let win = Math.floor(betCents * baseMult);
        win = Math.floor(win * productMult); // apply wild multipliers
        if (win > 0) {
          lineWins.push({
            startRow: r0,
            startCol: c0,
            endRow: r0 + (clamped - 1) * dr,
            endCol: c0 + (clamped - 1) * dc,
            length: clamped,
            symbol: target,
            winCents: win,
          });
          totalWinCents += win;
          if (target === "SEVEN" && clamped === 5) anySevenJackpot = true;
        }
      }
    };

    // Horizontal
    for (let r = 0; r < R; r++) scoreRun(r, 0, 0, +1);
    // Diagonal down-right
    for (let r = 0; r <= R - 3; r++) scoreRun(r, 0, +1, +1);
    // Diagonal up-right
    for (let r = 2; r < R; r++) scoreRun(r, 0, -1, +1);

    return { totalWinCents, lineWins, isJackpot: anySevenJackpot };
  }

  private pickWeightedSymbol(): SymbolId {
    const r = this.rng.next() * this.totalWeight;
    for (const e of this.cumulative) {
      if (r < e.cum) return e.id;
    }
    return this.cumulative[this.cumulative.length - 1].id;
  }

  private countScatters(grid: SymbolId[][]): number {
    let n = 0;
    for (let r = 0; r < this.config.rows; r++) {
      for (let c = 0; c < this.config.reels; c++) {
        if (grid[r][c] === "FS") n++;
      }
    }
    return n;
  }
}

/* ---------- Default config for 5x5 with a scatter ---------- */

export const DEFAULT_SYMBOLS: SymbolDef[] = [
  { id: "CHERRY", emoji: "🍒", weight: 36 },
  { id: "LEMON", emoji: "🍋", weight: 28 },
  { id: "STAR", emoji: "⭐", weight: 18 },
  { id: "SEVEN", emoji: "7️⃣", weight: 10 },
  { id: "FS", emoji: "🔔", weight: 8 }, // scatter: bell (tune weights later)
];

/** Multipliers per run length (applied to the bet). FS has no line pay. */
export const DEFAULT_PAYOUT: PayoutTable = {
  CHERRY: { 3: 1.5, 4: 3, 5: 6 },
  LEMON: { 3: 2, 4: 4, 5: 8 },
  STAR: { 3: 3, 4: 6, 5: 12 },
  SEVEN: { 3: 5, 4: 12, 5: 25 },
  FS: { 3: 0, 4: 0, 5: 0 }, // no pay as a line; only triggers bonus
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
