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
const bonusHud = document.getElementById("bonus-hud") as HTMLDivElement;

const paytableList = document.getElementById(
  "paytable-list"
) as HTMLUListElement;

let bonusActive = false;

const overlaySvg = document.querySelector<SVGSVGElement>("#line-overlay")!;
const slotStage = document.getElementById("slot-stage") as HTMLDivElement;

/* Bonus UI */
const bonusOverlay = document.getElementById("bonus-overlay") as HTMLDivElement;
const bonusProgress = document.getElementById(
  "bonus-progress"
) as HTMLDivElement;
const bonusTotalEl = document.getElementById("bonus-total") as HTMLSpanElement;
const bonusCloseBtn = document.getElementById(
  "bonus-close"
) as HTMLButtonElement;

bonusOverlay.hidden = true;
bonusCloseBtn.hidden = true;

/* ---------------- Euro helpers ---------------- */
function formatEuro(cents: number): string {
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
const emojiEls: HTMLSpanElement[][] = [];

function buildGrid(): void {
  reelsRoot.innerHTML = "";
  cellEls.length = 0;
  emojiEls.length = 0;

  for (let r = 0; r < ROWS; r++) {
    const rowCells: HTMLDivElement[] = [];
    const rowEmojis: HTMLSpanElement[] = [];

    for (let c = 0; c < COLS; c++) {
      const cell = document.createElement("div");
      cell.className = "reel";

      const emoji = document.createElement("span");
      emoji.className = "emoji";
      emoji.textContent = "🍒"; // placeholder

      cell.appendChild(emoji);
      reelsRoot.appendChild(cell);

      rowCells.push(cell);
      rowEmojis.push(emoji);
    }

    cellEls.push(rowCells);
    emojiEls.push(rowEmojis);
  }
}
buildGrid();

/* ---------------- Mappings ---------------- */
const symbolToEmoji: Record<SymbolId, string> = {
  CHERRY: "🍒",
  LEMON: "🍋",
  STAR: "⭐",
  SEVEN: "7️⃣",
  FS: "🔔",
};

const symbolColor: Record<SymbolId, string> = {
  CHERRY: "#ff6b6b",
  LEMON: "#ffd166",
  STAR: "#a78bfa",
  SEVEN: "#60a5fa",
  FS: "#f59e0b",
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

/** Base game: clear glow + lines + any wild badges. */
function clearAllEffects(): void {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      cellEls[r][c].classList.remove("win");
      removeWildBadge(r, c);
      if (!emojiEls[r][c].textContent || emojiEls[r][c].textContent === "") {
        emojiEls[r][c].textContent = symbolToEmoji["CHERRY"];
      }
    }
  }
  overlaySvg.replaceChildren();
}

/** Bonus spin: clear glow + lines ONLY. Keep wild badges in place. */
function clearForBonusSpin(): void {
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

/* ---------------- Wild badges ---------------- */
function setWildBadge(r: number, c: number, mult: number): void {
  removeWildBadge(r, c);
  if (!Number.isFinite(mult) || mult <= 0) return;
  const badge = document.createElement("div");
  badge.className = "wild-badge";
  badge.textContent = `${mult}x`; // <- “2x” format
  cellEls[r][c].appendChild(badge);
}
function removeWildBadge(r: number, c: number): void {
  const existing = cellEls[r][c].querySelector(".wild-badge");
  if (existing) existing.remove();
}

/* ---------------- Overlay drawing ---------------- */
function getCellCenter(r: number, c: number): { x: number; y: number } {
  const stageRect = slotStage.getBoundingClientRect();
  const cellRect = cellEls[r][c].getBoundingClientRect();
  return {
    x: cellRect.left - stageRect.left + cellRect.width / 2,
    y: cellRect.top - stageRect.top + cellRect.height / 2,
  };
}

function showWins(lineWins: LineWin[]): void {
  const rect = slotStage.getBoundingClientRect();
  overlaySvg.setAttribute("width", String(rect.width));
  overlaySvg.setAttribute("height", String(rect.height));
  overlaySvg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
  overlaySvg.replaceChildren();

  for (const w of lineWins) {
    // glow all cells in the segment (works for diagonals too)
    const rStep = Math.sign(w.endRow - w.startRow);
    const cStep = Math.sign(w.endCol - w.startCol);
    let r = w.startRow,
      c = w.startCol;
    for (let k = 0; k < w.length; k++) {
      cellEls[r][c].classList.add("win");
      r += rStep;
      c += cStep;
    }

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
  delayBetween = 140,
  wilds?: number[][]
): Promise<void> {
  const emojis = Object.values(symbolToEmoji);

  for (let col = 0; col < COLS; col++) {
    const t0 = performance.now();

    await new Promise<void>((resolve) => {
      const tick = (t: number) => {
        const elapsed = t - t0;

        if (elapsed < spinMs) {
          for (let r = 0; r < ROWS; r++) {
            const isWild = !!wilds && (wilds[r][col] | 0) > 0;
            // show nothing in the emoji span for wild cells (badge stays visible)
            emojiEls[r][col].textContent = isWild
              ? ""
              : emojis[Math.floor(Math.random() * emojis.length)];
          }
          requestAnimationFrame(tick);
        } else {
          for (let r = 0; r < ROWS; r++) {
            const isWild = !!wilds && (wilds[r][col] | 0) > 0;
            emojiEls[r][col].textContent = isWild
              ? ""
              : symbolToEmoji[grid[r][col]];
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

/* ---------------- Bonus helpers ---------------- */

/** Add/remove a temporary element for spotlight. */
function flashSpotlight(r: number, c: number): void {
  const spot = document.createElement("div");
  spot.className = "wild-spotlight";
  cellEls[r][c].appendChild(spot);
  setTimeout(() => spot.remove(), 600);
}

/** Ensure badge exists, then add a one-shot CSS animation class. */
function animateBadge(r: number, c: number, cls: "pop" | "bump"): void {
  const badge = cellEls[r][c].querySelector(
    ".wild-badge"
  ) as HTMLDivElement | null;
  if (!badge) return; // badge should already exist from renderWildBadges()
  badge.classList.remove("pop", "bump"); // reset any previous animation
  void badge.offsetWidth; // reflow to restart animation
  badge.classList.add(cls);
}

/** Render wild badges for all cells from the current wilds grid. */
function renderWildBadges(wilds: number[][]): void {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      setWildBadge(r, c, wilds[r][c] | 0);
    }
  }
}

/** Spawn brand-new x1 wilds in empty cells only (no stacking by landing). */
function spawnNewWilds(wilds: number[][]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const chanceToSpawn = 0.7; // 70% of spins spawn
  const maxNewPerSpin = 2; // up to 2 new wilds
  if (Math.random() > chanceToSpawn) return out;

  const empty: Array<[number, number]> = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if ((wilds[r][c] | 0) === 0) empty.push([r, c]);
    }
  }
  if (empty.length === 0) return out;

  // Pick 1 or 2 unique empties
  const want = Math.min(
    1 + (Math.random() < 0.4 ? 1 : 0),
    maxNewPerSpin,
    empty.length
  );
  for (let i = empty.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [empty[i], empty[j]] = [empty[j], empty[i]];
  }
  for (let i = 0; i < want; i++) {
    const [r, c] = empty[i];
    wilds[r][c] = 1;
    out.push([r, c]);
  }
  return out;
}

async function runBonusSession(freeSpins: number): Promise<void> {
  if (freeSpins <= 0) return;

  bonusActive = true;
  setDisabled(true);

  const wilds: number[][] = Array.from({ length: ROWS }, () =>
    Array(COLS).fill(0)
  );

  bonusOverlay.hidden = true;
  bonusCloseBtn.hidden = true;
  bonusHud.hidden = false;

  let bonusTotal = 0;
  const betCents = Number(betEl.value) || 100;

  let prevWinMask: boolean[][] | null = null;

  for (let i = 0; i < freeSpins; i++) {
    bonusHud.textContent = `FREE SPINS ${i + 1} / ${freeSpins}`;

    // 1) Increment ONLY wilds that were in last spin’s wins → animate bump
    if (prevWinMask) {
      const incCells = incrementWildsByMask(wilds, prevWinMask /*, cap */);
      renderWildBadges(wilds);
      for (const [r, c] of incCells) {
        animateBadge(r, c, "bump");
      }
    }

    // 2) Clear glow/lines (badges stay)
    clearForBonusSpin();

    // 3) Spawn brand-new wilds in empty cells → render & POP + spotlight
    const newWilds = spawnNewWilds(wilds);
    renderWildBadges(wilds);
    for (const [r, c] of newWilds) {
      animateBadge(r, c, "pop");
      flashSpotlight(r, c);
    }

    // 4) Spin/settle (slower in bonus), wild cells show no emoji (badge only)

    const grid = machine.generateGridForBonus(wilds);
    await animateColumnsThenResolve(grid, 900, 200, wilds);

    // 5) Score with wild overlay; draw wins; accumulate
    const scored = machine.scoreGrid(grid, betCents, wilds, true);
    showWins(scored.lineWins);
    bonusTotal += scored.totalWinCents;

    // 6) Prepare win mask for next spin’s increment
    prevWinMask = buildWinMask(scored.lineWins);

    await new Promise((res) => setTimeout(res, 700));

    if (scored.bonusRetriggerSpins && scored.bonusRetriggerSpins > 0) {
      freeSpins += scored.bonusRetriggerSpins; // +2 spins per retrigger
      // Optional: show a small HUD flash “+2 SPINS!”
    }
  }

  // credit once
  machine.addFunds(bonusTotal);
  updateUIFromWallet();

  // cleanup & end card
  bonusHud.hidden = true;
  bonusProgress.textContent = `Bonus Complete`;
  bonusTotalEl.textContent = formatEuro(bonusTotal);
  bonusCloseBtn.hidden = false;
  bonusOverlay.hidden = false;
  bonusCloseBtn.onclick = () => {
    bonusOverlay.hidden = true;
  };

  setDisabled(false);
  bonusActive = false;
}

function buildWinMask(lineWins: LineWin[]): boolean[][] {
  const mask: boolean[][] = Array.from({ length: ROWS }, () =>
    Array(COLS).fill(false)
  );
  for (const w of lineWins) {
    const rStep = Math.sign(w.endRow - w.startRow);
    const cStep = Math.sign(w.endCol - w.startCol);
    let r = w.startRow,
      c = w.startCol;
    for (let k = 0; k < w.length; k++) {
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) mask[r][c] = true;
      r += rStep;
      c += cStep;
    }
  }
  return mask;
}

function incrementWildsByMask(
  wilds: number[][],
  mask: boolean[][],
  cap = Number.POSITIVE_INFINITY
): Array<[number, number]> {
  const inc: Array<[number, number]> = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (mask[r][c] && wilds[r][c] > 0) {
        const before = wilds[r][c];
        wilds[r][c] = Math.min(cap, before + 1);
        if (wilds[r][c] !== before) inc.push([r, c]);
      }
    }
  }
  return inc;
}
/* ---------------- Events ---------------- */
async function onSpinClick(): Promise<void> {
  try {
    setDisabled(true);
    clearAllEffects(); // <-- was clearWinEffects()

    machine.setBetCents(Number(betEl.value));
    const result = machine.spin();

    await animateColumnsThenResolve(result.grid, 600, 140);
    lastWinEl.textContent = formatEuro(result.totalWinCents);
    showWins(result.lineWins);
    updateUIFromWallet();

    if (result.freeSpinsAwarded > 0) {
      await new Promise((res) => setTimeout(res, 600));
      await runBonusSession(result.freeSpinsAwarded);
    }
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
