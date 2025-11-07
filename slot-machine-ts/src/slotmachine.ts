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
    const rows = this.config.rows;
    const cols = this.config.reels;
    const grid: SymbolId[][] = Array.from({ length: rows }, () =>
      Array<SymbolId>(cols)
    );

    for (let c = 0; c < cols; c++) {
      let fsPlaced = false;
      for (let r = 0; r < rows; r++) {
        let sym: SymbolId;
        do {
          sym = this.pickWeightedSymbol();
        } while (sym === "FS" && fsPlaced); // only one FS per column
        grid[r][c] = sym;
        if (sym === "FS") fsPlaced = true;
      }
    }
    return grid;
  }

  /**
   * Generate a bonus-game grid with:
   *  - ≤1 FS (bell) per column
   *  - NO FS on cells that already have a wild (wilds[r][c] > 0)
   */
  generateGridForBonus(wilds: number[][]): SymbolId[][] {
    const rows = this.config.rows;
    const cols = this.config.reels;
    const grid: SymbolId[][] = Array.from({ length: rows }, () =>
      Array<SymbolId>(cols)
    );

    for (let c = 0; c < cols; c++) {
      let fsPlaced = false;
      for (let r = 0; r < rows; r++) {
        const cellHasWild = (wilds[r][c] | 0) > 0;
        let sym: SymbolId;
        do {
          sym = this.pickWeightedSymbol();
          // reject FS if already placed in col OR if a wild occupies this cell
        } while (sym === "FS" && (fsPlaced || cellHasWild));
        grid[r][c] = sym;
        if (sym === "FS") fsPlaced = true;
      }
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
    wilds?: number[][],
    isInBonus: boolean = false
  ): ScoredGrid {
    const lineWins: LineWin[] = [];
    let totalWinCents = 0;
    let anySevenJackpot = false;

    const R = this.config.rows;
    const C = this.config.reels;
    const bestSymbol = this.bestFiveSymbol();

    const scoreRun = (r0: number, c0: number, dr: number, dc: number) => {
      // 1) Find target symbol (first non-wild along the path). If none, use best-paying symbol.
      let r = r0,
        c = c0;
      let target: SymbolId | null = null;
      for (let k = 0; k < 5 && r >= 0 && r < R && c >= 0 && c < C; k++) {
        const sym = grid[r][c];
        const isWildCell = wilds && (wilds[r][c] | 0) > 0;
        if (!isWildCell) {
          target = sym;
          break;
        }
        r += dr;
        c += dc;
      }
      if (!target) target = bestSymbol; // all-wild leading segment → treat as best symbol

      // 2) Count run length where cells are target OR wild; multiply by product of wild multipliers
      r = r0;
      c = c0;
      let len = 0;
      let productMult = 1;
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
        // Optional safety: cap per-line multiplier if you want (e.g., productMult = Math.min(productMult, 500);)
        win = Math.floor(win * productMult);
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

    // Left-to-right starts
    for (let r = 0; r < R; r++) scoreRun(r, 0, 0, +1);
    for (let r = 0; r <= R - 3; r++) scoreRun(r, 0, +1, +1);
    for (let r = 2; r < R; r++) scoreRun(r, 0, -1, +1);

    // Bonus retrigger: in bonus mode, 3+ FS anywhere → +2 spins
    let bonusRetriggerSpins = 0;
    if (isInBonus) {
      const scatters = this.countScatters(grid);
      if (scatters >= 3) bonusRetriggerSpins = 2;
    }

    return {
      totalWinCents,
      lineWins,
      isJackpot: anySevenJackpot,
      bonusRetriggerSpins,
    };
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
  /** Highest-paying *regular* symbol for 5-in-a-row (used for all-wild lines). */
  private bestFiveSymbol(): SymbolId {
    let best: SymbolId | null = null;
    let bestPay = -Infinity;
    for (const s of this.config.symbols) {
      if (s.id === "FS") continue; // FS never pays as a line
      const pay = this.config.payoutTable[s.id][5];
      if (pay > bestPay) {
        bestPay = pay;
        best = s.id;
      }
    }
    // fallback: first non-FS symbol
    return best ?? this.config.symbols.find((s) => s.id !== "FS")!.id;
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
