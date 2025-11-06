import {
  createDefaultMachine,
  DEFAULT_PAYOUT,
  DEFAULT_SYMBOLS,
} from "./slotmachine";
import type { SymbolId, LineWin } from "./types";
import { loadWallet, saveWallet } from "./storage";

/* ---------------- DOM refs ---------------- */
const balanceEl = document.getElementById("balance") as HTMLSpanElement;
const betEl = document.getElementById("bet") as HTMLSelectElement;
const lastWinEl = document.getElementById("last-win") as HTMLSpanElement;
const reelsRoot = document.getElementById("reels") as HTMLDivElement;
const spinBtn = document.getElementById("spin") as HTMLButtonElement;
const addFundsBtn = document.getElementById("add-funds") as HTMLButtonElement;
const paytableList = document.getElementById(
  "paytable-list"
) as HTMLUListElement;

/** SVG overlay for win lines — non-null assertion (!) because it exists in index.html */
const overlaySvg = document.querySelector<SVGSVGElement>("#line-overlay")!;
const slotStage = document.getElementById("slot-stage") as HTMLDivElement;

/* ---------------- Euro helpers ---------------- */
function formatEuro(cents: number): string {
  // You’re in Åland/Finland; use standard Euro formatting.
  // Keeping it simple: €X.YY
  return `€${(cents / 100).toFixed(2)}`;
}

/* ---------------- Game init ---------------- */
const persisted = loadWallet();
const initialBalance = persisted?.balanceCents ?? 10000;
const machine = createDefaultMachine(
  initialBalance,
  Number(betEl.value || 100)
);

/* ---------------- Grid setup ---------------- */
const ROWS = 5;
const COLS = 5;

const cellEls: HTMLDivElement[][] = [];
function buildGrid(): void {
  reelsRoot.innerHTML = "";
  cellEls.length = 0;

  for (let r = 0; r < ROWS; r++) {
    const rowCells: HTMLDivElement[] = [];
    for (let c = 0; c < COLS; c++) {
      const cell = document.createElement("div");
      cell.className = "reel";
      cell.textContent = "🍒"; // placeholder
      reelsRoot.appendChild(cell);
      rowCells.push(cell);
    }
    cellEls.push(rowCells);
  }
}
buildGrid();

/* ---------------- Mappings ---------------- */
const symbolToEmoji: Record<SymbolId, string> = {
  CHERRY: "🍒",
  LEMON: "🍋",
  STAR: "⭐",
  SEVEN: "7️⃣",
};

const symbolColor: Record<SymbolId, string> = {
  CHERRY: "#ff6b6b",
  LEMON: "#ffd166",
  STAR: "#a78bfa",
  SEVEN: "#60a5fa",
};

/* ---------------- UI sync ---------------- */
function updateUIFromWallet(): void {
  const w = machine.getWallet();
  balanceEl.textContent = formatEuro(w.balanceCents);
  Array.from(betEl.options).forEach((o) => {
    o.selected = Number(o.value) === w.betCents;
  });
  saveWallet({ balanceCents: w.balanceCents });
}

function clearWinEffects(): void {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      cellEls[r][c].classList.remove("win");
    }
  }
  overlaySvg.replaceChildren();
}

function setDisabled(disabled: boolean): void {
  spinBtn.disabled = disabled;
  addFundsBtn.disabled = disabled;
  betEl.disabled = disabled;
}

/* ---------------- Overlay drawing ---------------- */
/** Center of a given cell, in overlay (slotStage) coordinates. */
function getCellCenter(r: number, c: number): { x: number; y: number } {
  const stageRect = slotStage.getBoundingClientRect();
  const cellRect = cellEls[r][c].getBoundingClientRect();
  return {
    x: cellRect.left - stageRect.left + cellRect.width / 2,
    y: cellRect.top - stageRect.top + cellRect.height / 2,
  };
}

/** Draw straight lines across winning segments + glow cells. */
function showWins(lineWins: LineWin[]): void {
  // Size the overlay to the stage
  const rect = slotStage.getBoundingClientRect();
  overlaySvg.setAttribute("width", String(rect.width));
  overlaySvg.setAttribute("height", String(rect.height));
  overlaySvg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);

  overlaySvg.replaceChildren();

  for (const w of lineWins) {
    // Glow all cells on the path
    let r = w.startRow;
    let c = w.startCol;
    const rStep = Math.sign(w.endRow - w.startRow); // -1, 0, +1
    const cStep = Math.sign(w.endCol - w.startCol); //  +1
    for (let k = 0; k < w.length; k++) {
      cellEls[r][c].classList.add("win");
      r += rStep;
      c += cStep;
    }

    // Straight line between centers
    const start = getCellCenter(w.startRow, w.startCol);
    const end = getCellCenter(w.endRow, w.endCol);

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(start.x));
    line.setAttribute("y1", String(start.y));
    line.setAttribute("x2", String(end.x));
    line.setAttribute("y2", String(end.y));
    line.setAttribute("class", "win-line");
    line.setAttribute("stroke", symbolColor[w.symbol]);
    overlaySvg.appendChild(line);
  }
}

/* ---------------- Animation: column-by-column ---------------- */
async function animateColumnsThenResolve(
  grid: SymbolId[][],
  spinMs = 600,
  delayBetween = 140
): Promise<void> {
  const emojis = Object.values(symbolToEmoji);

  for (let col = 0; col < COLS; col++) {
    const t0 = performance.now();

    await new Promise<void>((resolve) => {
      const tick = (t: number) => {
        const elapsed = t - t0;
        if (elapsed < spinMs) {
          for (let r = 0; r < ROWS; r++) {
            const idx = Math.floor(Math.random() * emojis.length);
            cellEls[r][col].textContent = emojis[idx];
          }
          requestAnimationFrame(tick);
        } else {
          for (let r = 0; r < ROWS; r++) {
            cellEls[r][col].textContent = symbolToEmoji[grid[r][col]];
          }
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });

    if (col < COLS - 1) {
      await new Promise((res) => setTimeout(res, delayBetween));
    }
  }
}

/* ---------------- Paytable UI ---------------- */
function renderPaytable(): void {
  paytableList.innerHTML = "";
  for (const def of DEFAULT_SYMBOLS) {
    const li = document.createElement("li");
    const p = DEFAULT_PAYOUT[def.id];
    li.textContent = `${def.emoji} ${def.id} — 3-in-row: ${p[3]}x, 4: ${p[4]}x, 5: ${p[5]}x`;
    paytableList.appendChild(li);
  }
}

/* ---------------- Events ---------------- */
async function onSpinClick(): Promise<void> {
  try {
    setDisabled(true);
    clearWinEffects();
    machine.setBetCents(Number(betEl.value));

    const result = machine.spin();

    // Column-by-column animation, then reveal and draw lines
    await animateColumnsThenResolve(result.grid, 600, 140);
    lastWinEl.textContent = formatEuro(result.totalWinCents);
    showWins(result.lineWins);

    updateUIFromWallet();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Unknown error");
  } finally {
    setDisabled(false);
  }
}

function onAddFunds(): void {
  machine.addFunds(1000); // +€10.00
  updateUIFromWallet();
}

function onBetChange(): void {
  try {
    machine.setBetCents(Number(betEl.value));
  } catch (err) {
    alert(err instanceof Error ? err.message : "Invalid bet");
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.code === "Space" && !spinBtn.disabled) {
    e.preventDefault();
    void onSpinClick();
  }
}

spinBtn.addEventListener("click", () => void onSpinClick());
addFundsBtn.addEventListener("click", onAddFunds);
betEl.addEventListener("change", onBetChange);
window.addEventListener("keydown", onKeyDown);

/* ---------------- Initial render ---------------- */
renderPaytable();
updateUIFromWallet();
