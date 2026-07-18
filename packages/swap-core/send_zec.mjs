/** One-off ZEC sender from the hot wallet. Reads the WIF locally, NEVER logs it.
 * Usage: node --import tsx send_zec.mjs <dest> [amountZat|all] [--broadcast] */
import * as fs from 'node:fs';
import * as utxolib from '@bitgo/utxo-lib';
import { blake2b } from '@noble/hashes/blake2b';
import { makeZcashChain } from './src/zcash/chain.js';
import { branchIdAtHeight, zip317Fee, DEFAULT_EXPIRY_DELTA } from './src/zcash/network.js';

const { ECPair, script: bscript } = utxolib;
const ZCASH = utxolib.networks.zcash;
const HOT = 't1MX4hCpMUagW7xEo1FGGchXuQFCEaF4yk5';
const KEYFILE = `${process.env.HOME}/Desktop/keys/zec-hot-wallet.txt`;
const VGID_SAPLING = 0x892f2085, SAPLING_V4 = 4, SEQ = 0xfffffffe;

const dest = process.argv[2];
const amtArg = process.argv[3] ?? 'all';
const BROADCAST = process.argv.includes('--broadcast');
if (!dest) { console.error('need dest'); process.exit(1); }

function loadKey() {
  const m = fs.readFileSync(KEYFILE, 'utf8').match(/WIF\s*:?\s*([1-9A-HJ-NP-Za-km-z]{40,})/);
  if (!m) throw new Error('no WIF');
  const pair = ECPair.fromWIF(m[1]);
  const spk = utxolib.address.toOutputScript(HOT, ZCASH);
  if (!utxolib.crypto.hash160(Buffer.from(pair.publicKey)).equals(spk.subarray(3, 23)))
    throw new Error('WIF mismatch');
  return pair;
}
const Z32 = Buffer.alloc(32);
const pers = (s, br) => { const p = Buffer.alloc(16); p.write(s); if (br !== undefined) p.writeUInt32LE(br >>> 0, s.length); return p; };
const blk = (m, p) => Buffer.from(blake2b(m, { dkLen: 32, personalization: p }));
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const vs = (b) => Buffer.concat([Buffer.from([b.length]), b]);
function zip243(t, sc, amt, br) {
  const prev = Buffer.concat(t.ins.map((i) => Buffer.concat([i.hash, u32(i.index)])));
  const seq = Buffer.concat(t.ins.map((i) => u32(i.sequence)));
  const outs = Buffer.concat(t.outs.map((o) => Buffer.concat([u64(o.value), vs(o.script)])));
  const hdr = Buffer.alloc(4); hdr.writeUInt32LE((t.version | (t.overwintered ? 0x80000000 : 0)) >>> 0);
  const inp = t.ins[0];
  const pre = Buffer.concat([hdr, u32(t.versionGroupId), blk(prev, pers('ZcashPrevoutHash')),
    blk(seq, pers('ZcashSequencHash')), blk(outs, pers('ZcashOutputsHash')), Z32, Z32, Z32,
    u32(t.locktime), u32(t.expiryHeight), u64(0), u32(1),
    inp.hash, u32(inp.index), vs(sc), u64(amt), u32(inp.sequence)]);
  return blk(pre, pers('ZcashSigHash', br));
}

(async () => {
  const chain = makeZcashChain('mainnet');
  const pair = loadKey();
  const tip = await chain.tipHeight();
  const branchId = branchIdAtHeight('mainnet', tip);
  const utxos = await chain.utxos(HOT);
  if (!utxos.length) throw new Error('hot wallet empty');
  const spendable = utxos.reduce((a, x) => a + x.valueZat, 0);
  const fee = zip317Fee(utxos.length, 1);
  const outValue = amtArg === 'all' ? spendable - fee : Number(amtArg);
  if (!(outValue > 0) || outValue > spendable - fee) throw new Error(`bad amount ${outValue}`);
  const destSpk = utxolib.address.toOutputScript(dest, ZCASH);

  const txb = utxolib.bitgo.createTransactionBuilderForNetwork(ZCASH);
  txb.setVersion(SAPLING_V4); txb.setVersionGroupId(VGID_SAPLING); txb.setConsensusBranchId(branchId);
  txb.setExpiryHeight(tip + DEFAULT_EXPIRY_DELTA); txb.setLockTime(0);
  for (const u of utxos) txb.addInput(u.txid, u.vout, SEQ);
  txb.addOutput(destSpk, outValue);
  const tx = txb.buildIncomplete();
  const hotSpk = utxolib.address.toOutputScript(HOT, ZCASH);
  utxos.forEach((u, i) => {
    const sh = tx.hashForSignatureByNetwork(i, hotSpk, u.valueZat, 1);
    const sig = bscript.signature.encode(Buffer.from(pair.sign(sh)), 1);
    tx.setInputScript(i, bscript.compile([sig, Buffer.from(pair.publicKey)]));
  });
  const hex = tx.toBuffer().toString('hex'), txid = tx.getId();
  const chk = zip243(tx, hotSpk, utxos[0].valueZat, branchId);
  const { signature } = bscript.signature.decode(bscript.decompile(tx.ins[0].script)[0]);
  const ok = ECPair.fromPublicKey(Buffer.from(pair.publicKey)).verify(chk, signature);
  console.log(`tip=${tip} branch=0x${branchId.toString(16)} inputs=${utxos.length} spendable=${spendable} fee=${fee}`);
  console.log(`SEND ${outValue} zat = ${outValue / 1e8} ZEC -> ${dest}`);
  console.log(`txid=${txid} localSighashECDSA_VALID=${ok}`);
  if (!ok) throw new Error('local verify FAILED — not broadcasting');
  if (BROADCAST) { const id = await chain.broadcast(hex); console.log(`BROADCAST OK txid=${id}`); }
  else console.log('(dry run)');
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
