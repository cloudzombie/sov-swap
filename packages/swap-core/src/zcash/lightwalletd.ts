/**
 * Lightwalletd (gRPC) Zcash chain access — FREE, no API key, no self-hosted node.
 *
 * Public lightwalletd instances (ECC's zec.rocks, grant-funded) expose exactly what the
 * desk needs over gRPC/TLS, and — verified against the live service — they have the
 * **transparent-address index enabled**, so `GetAddressUtxos` works for watching HTLC
 * deposits. This replaces the paid/blacklisting REST providers entirely.
 *
 *   tip        ← GetLightdInfo.blockHeight / GetLatestBlock
 *   utxos      ← GetAddressUtxos           (transparent index)
 *   broadcast  ← SendTransaction
 *   txInputs   ← GetTransaction            (raw tx → parse scriptSig)
 *
 * Byte-order note: lightwalletd carries txids/hashes in *internal* (little-endian) order;
 * display/txid hex is the reverse. We reverse at the boundary so the rest of the code (and
 * the tx builder) sees standard display txids.
 */
import { createRequire } from 'node:module';
import * as utxolib from '@bitgo/utxo-lib';
import type { ZcashChain, Utxo, TxInput } from './chain.js';
import { ZcashChainError } from './chain.js';
import type { ZcashNet } from './network.js';

const require = createRequire(import.meta.url);

/** Default free endpoints, tried in order (regional zec.rocks, all TLS:443). */
const DEFAULT_ENDPOINTS = ['na.zec.rocks:443', 'zec.rocks:443', 'eu.zec.rocks:443'];

interface Grpc {
  streamer: any;
  grpc: any;
}

let cached: Grpc | null = null;

/** Load the gRPC client class from the bundled proto (lazy; grpc is a heavy dep). */
function loadGrpc(): Grpc {
  if (cached) return cached;
  const grpc = require('@grpc/grpc-js');
  const protoLoader = require('@grpc/proto-loader');
  // proto/ sits at the package root, present in both src and dist layouts.
  const protoDir = new URL('../../proto', import.meta.url).pathname;
  const def = protoLoader.loadSync(`${protoDir}/service.proto`, {
    includeDirs: [protoDir],
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    bytes: Buffer,
  });
  const pkg = grpc.loadPackageDefinition(def);
  const streamer = pkg.cash.z.wallet.sdk.rpc.CompactTxStreamer;
  cached = { streamer, grpc };
  return cached;
}

function reverseHex(buf: Buffer): string {
  return Buffer.from(buf).reverse().toString('hex');
}
function toInternal(displayHex: string): Buffer {
  return Buffer.from(displayHex, 'hex').reverse();
}

export class LightwalletdZcash implements ZcashChain {
  readonly net: ZcashNet;
  private readonly endpoints: string[];
  private clients: any[] = [];
  private tipCache: { h: number; ts: number } | null = null;
  private static readonly TIP_TTL_MS = 30_000;

  constructor(opts: { net?: ZcashNet; endpoints?: string[] } = {}) {
    this.net = opts.net ?? 'mainnet';
    if (this.net !== 'mainnet') {
      throw new ZcashChainError('LightwalletdZcash is configured for mainnet; pass testnet endpoints to use testnet');
    }
    this.endpoints = opts.endpoints ?? DEFAULT_ENDPOINTS;
  }

  private conns(): any[] {
    if (this.clients.length) return this.clients;
    const { streamer, grpc } = loadGrpc();
    this.clients = this.endpoints.map((e) => new streamer(e, grpc.credentials.createSsl()));
    return this.clients;
  }

  /** Call `method` with failover across endpoints; rejects only if ALL endpoints fail. */
  private call<T>(method: string, arg: unknown, ms = 15_000): Promise<T> {
    const clients = this.conns();
    let i = 0;
    const tryOne = (): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const client = clients[i];
        client[method](arg, { deadline: new Date(Date.now() + ms) }, (err: any, resp: T) => {
          if (!err) return resolve(resp);
          i += 1;
          if (i < clients.length) return resolve(tryOne());
          reject(new ZcashChainError(`lightwalletd ${method} failed on all endpoints: ${err.message || err}`));
        });
      });
    return tryOne();
  }

  async tipHeight(): Promise<number> {
    const now = Date.now();
    if (this.tipCache && now - this.tipCache.ts < LightwalletdZcash.TIP_TTL_MS) return this.tipCache.h;
    const info = await this.call<{ blockHeight: string }>('getLightdInfo', {});
    const h = Number(info.blockHeight);
    if (!Number.isFinite(h) || h <= 0) throw new ZcashChainError('lightwalletd returned no block height');
    this.tipCache = { h, ts: now };
    return h;
  }

  async utxos(address: string): Promise<Utxo[]> {
    const [tip, reply] = await Promise.all([
      this.tipHeight(),
      this.call<{ addressUtxos?: any[] }>('getAddressUtxos', {
        addresses: [address],
        startHeight: 0,
        maxEntries: 0, // 0 = no limit
      }),
    ]);
    const list = reply.addressUtxos ?? [];
    return list.map((u) => {
      const height = Number(u.height);
      return {
        txid: reverseHex(u.txid as Buffer), // internal → display
        vout: Number(u.index),
        valueZat: Number(u.valueZat),
        confirmations: height > 0 ? Math.max(0, tip - height + 1) : 0,
      } satisfies Utxo;
    });
  }

  async broadcast(rawHex: string): Promise<string> {
    const resp = await this.call<{ errorCode: number | string; errorMessage: string }>('sendTransaction', {
      data: Buffer.from(rawHex, 'hex'),
      height: 0,
    });
    const code = Number(resp.errorCode);
    if (code !== 0) {
      throw new ZcashChainError(`broadcast rejected (code ${resp.errorCode}): ${resp.errorMessage}`);
    }
    // SendTransaction returns a status, not the txid — compute it from the raw tx.
    const tx = utxolib.bitgo.createTransactionFromBuffer(Buffer.from(rawHex, 'hex'), utxolib.networks.zcash, {
      amountType: 'number',
    });
    return tx.getId();
  }

  async txInputs(txid: string): Promise<TxInput[]> {
    const resp = await this.call<{ data: Buffer }>('getTransaction', { hash: toInternal(txid) });
    if (!resp?.data?.length) throw new ZcashChainError(`transaction ${txid} not found`);
    const tx = utxolib.bitgo.createTransactionFromBuffer(resp.data, utxolib.networks.zcash, { amountType: 'number' });
    return tx.ins.map((i: any) => ({ script: i.script as Buffer }));
  }
}
