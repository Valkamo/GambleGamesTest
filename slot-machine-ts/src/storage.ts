// src/storage.ts

const KEY = "ts-slots-wallet";

export interface PersistedWallet {
  balanceCents: number;
}

export function saveWallet(data: PersistedWallet): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // ignore storage errors (private browsing / quota)
  }
}

export function loadWallet(): PersistedWallet | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    // narrow shape
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as any).balanceCents === "number"
    ) {
      return { balanceCents: (parsed as any).balanceCents };
    }
    return null;
  } catch {
    return null;
  }
}
