/**
 * Swap persistence — a small append-truth JSON store. Swap volume on a market-maker desk
 * is low (one record per trade, resolved in minutes), so a single JSON file with atomic
 * writes is the right amount of machinery: durable across restarts, trivially inspectable,
 * no database to run on the faucet droplet.
 *
 * Durability matters here because a record IS the memory of money in flight: if the desk
 * has locked XUS and crashes, the persisted terms + phase are what let it resume, observe
 * the chains, and either sweep or refund rather than abandon the escrow.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { SwapState } from '@sov-swap/core';

export class SwapStore {
  private swaps = new Map<string, SwapState>();
  private readonly file: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'swaps.json');
    if (existsSync(this.file)) {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as SwapState[];
      for (const s of raw) this.swaps.set(s.terms.id, s);
    }
  }

  get(id: string): SwapState | undefined {
    return this.swaps.get(id);
  }

  /** All swaps, newest first. */
  all(): SwapState[] {
    return [...this.swaps.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  /** Swaps still being driven (not in a terminal phase). */
  active(): SwapState[] {
    const terminal = new Set(['zec_swept', 'xus_refunded', 'aborted']);
    return this.all().filter((s) => !terminal.has(s.phase));
  }

  put(s: SwapState): void {
    this.swaps.set(s.terms.id, s);
    this.flush();
  }

  private flush(): void {
    // Atomic: write a temp file then rename over the target, so a crash mid-write never
    // leaves a truncated store.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.swaps.values()], null, 2));
    renameSync(tmp, this.file);
  }
}
