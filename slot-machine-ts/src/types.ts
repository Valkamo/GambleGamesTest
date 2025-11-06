export type SymbolId = "CHERRY" | "LEMON" | "STAR" | "SEVEN";

export interface SymbolDef {
  id: SymbolId;
  emoji: string;
  weight: number;
}

/** Payout per symbol depends on run length (3, 4, 5 in a row). */
export type RunPayout = { 3: number; 4: number; 5: number };

export type PayoutTable = Record<SymbolId, RunPayout>;

export interface SlotConfig {
  reels: number; // columns (5)
  rows: number; // rows (5)
  symbols: SymbolDef[];
  payoutTable: PayoutTable;
}

export interface Wallet {
  balanceCents: number;
  betCents: number;
}

/** Win segment coordinates (horizontal or diagonal), inclusive. */
export interface LineWin {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  length: 3 | 4 | 5;
  symbol: SymbolId;
  winCents: number;
}

export interface SpinResult {
  grid: SymbolId[][]; // [row][col], rows x reels
  totalWinCents: number;
  lineWins: LineWin[];
  isJackpot: boolean; // true if any 5-in-a-row of SEVEN from leftmost
}
