/**
 * Zcash network + consensus-branch-id configuration.
 *
 * THE BRANCH ID IS THE SHARP EDGE. Zcash's transparent sighash (ZIP-243/244) commits
 * to the consensus branch id of the *currently active* network upgrade. Zcash ships a
 * network upgrade changes that id. If we sign against a
 * stale branch id every transaction we produce is silently invalid — it will not relay,
 * with no useful error. This has repeatedly broken shipped wallets (Trust Wallet,
 * Ledger), so we do NOT rely on the bundled library defaults: `@bitgo/utxo-lib@11.24.0`
 * only knows branch ids up to NU6.2, and NU6.3 activates 2026-07-28.
 *
 * Therefore the branch id is EXPLICIT CONFIG here, overridable at runtime, and the
 * active upgrade is selected by height so a swap spanning an activation still signs
 * correctly. Before each upgrade: add the entry, set `activationHeight`, and verify the
 * activation boundary.
 *
 * Sources to track: https://z.cash/upgrade/ and
 * https://github.com/zcash/zcash/blob/master/src/consensus/upgrades.cpp
 */
import * as utxolib from '@bitgo/utxo-lib';

export type ZcashNet = 'mainnet';

/** A Zcash network upgrade: its consensus branch id and the height it activates at. */
export interface NetworkUpgrade {
  name: string;
  /** Consensus branch id — commits into the ZIP-243/244 sighash. */
  branchId: number;
  /** First height at which this branch id is in force. */
  activationHeight: number;
}

/**
 * Mainnet upgrade table, oldest→newest. Extend as Zcash ships upgrades; the newest
 * entry whose `activationHeight` is <= the tip governs.
 */
export const MAINNET_UPGRADES: NetworkUpgrade[] = [
  { name: 'NU5', branchId: 0xc2d6d0b4, activationHeight: 1_687_104 },
  { name: 'NU6', branchId: 0xc8e71055, activationHeight: 2_726_400 },
  { name: 'NU6.1', branchId: 0x4dec4df0, activationHeight: 3_146_400 },
  { name: 'NU6.2', branchId: 0x5437f330, activationHeight: 3_364_600 },
  { name: 'NU6.3', branchId: 0x37a5165b, activationHeight: 3_428_143 },
];

/** The bitgo network object for a given net. */
export function utxoNetwork(_net: ZcashNet) {
  return utxolib.networks.zcash;
}

export function upgradeTable(_net: ZcashNet): NetworkUpgrade[] {
  return MAINNET_UPGRADES;
}

/**
 * The consensus branch id in force at `height` — the newest upgrade that has activated.
 * Throws below the oldest known upgrade rather than guessing: signing with a wrong
 * branch id produces silently-unbroadcastable transactions, so failing loudly is the
 * only safe behaviour.
 */
export function branchIdAtHeight(net: ZcashNet, height: number): number {
  const table = upgradeTable(net);
  let active: NetworkUpgrade | undefined;
  for (const u of table) {
    if (height >= u.activationHeight) active = u;
  }
  if (!active) {
    throw new Error(
      `no known Zcash consensus branch id for ${net} height ${height} ` +
        `(oldest known upgrade ${table[0].name} activates at ${table[0].activationHeight})`,
    );
  }
  return active.branchId;
}

/** The upgrade record in force at `height` (name + branch id), for logging/diagnostics. */
export function upgradeAtHeight(net: ZcashNet, height: number): NetworkUpgrade {
  const id = branchIdAtHeight(net, height);
  return upgradeTable(net).find((u) => u.branchId === id)!;
}

/**
 * Default expiry window, in blocks, for a transaction we broadcast. Zcash drops a tx
 * from the mempool once the tip passes `nExpiryHeight`; the network default is 40 blocks
 * (~50 min at 75s). We use a wider window so a claim still lands if a public API is slow
 * or we need to rebroadcast — expiry is a safety valve, not a deadline we want to race.
 */
export const DEFAULT_EXPIRY_DELTA = 100;

/**
 * ZIP-317 conventional fee. Since 2023 the network expects 5000 zatoshi per "logical
 * action", minimum 2 actions — so a simple 1-in/1-out transparent spend is 10000 zat
 * (0.0001 ZEC). We deduct this from the claimed output, which is what lets the desk
 * hold ZERO pre-funded ZEC: the claim pays for itself out of the amount being claimed.
 */
export const ZIP317_MARGINAL_FEE_ZAT = 5_000;
export const ZIP317_GRACE_ACTIONS = 2;

/** ZIP-317 fee for a transparent tx with the given input/output counts, in zatoshi. */
export function zip317Fee(inputs: number, outputs: number): number {
  const logicalActions = Math.max(ZIP317_GRACE_ACTIONS, Math.max(inputs, outputs));
  return logicalActions * ZIP317_MARGINAL_FEE_ZAT;
}
