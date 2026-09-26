// Independent research implementation of the published ZRunes v1 rules.
// Source: bitcoinuniverseio/docs-zerdinals-and-zrunes at de03cd1850cace694320ba3cc44789c2036daa7a (CC BY 4.0).
// Consensus validity and complete decoded block delivery belong to the caller.
import { createHash } from 'node:crypto';
import { decode, decodeName, commitmentHash } from './codec.mjs';

export const ACTIVATION = Object.freeze({ regtest: 1, testnet: 4150000, mainnet: 3470000 });
const MAX = (1n << 128n) - 1n;
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest();
const clone = (value) => structuredClone(value);
const integer = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`invalid ${name}`);
  return value;
};
const hex = (value, name, length) => {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(value) || (length && value.length !== length)) throw new Error(`invalid ${name}`);
  return value;
};
const checked = (value) => {
  if (value < 0n || value > MAX) throw new Error('u128 accounting overflow');
  return value;
};
const outputKey = (txid, index) => `${txid}:${index}`;
const transparent = (output) => !output.scriptPubKey.hex.startsWith('6a');

// Native scriptSig pushes have a broader grammar than ZRunestone carrier pushes.
function lastScriptPush(scriptHex) {
  const bytes = Buffer.from(hex(scriptHex, 'input script'), 'hex');
  let last;
  for (let i = 0; i < bytes.length;) {
    const opcode = bytes[i++];
    if (opcode === 0x4f || (opcode >= 0x51 && opcode <= 0x60)) {
      last = Buffer.from([opcode === 0x4f ? 0x81 : opcode - 0x50]);
      continue;
    }
    let length;
    if (opcode <= 0x4b) length = opcode;
    else if (opcode >= 0x4c && opcode <= 0x4e) {
      const size = opcode === 0x4c ? 1 : opcode === 0x4d ? 2 : 4;
      if (size > bytes.length - i) throw new Error('truncated script push length');
      length = bytes.readUIntLE(i, size);
      i += size;
    } else throw new Error('nonpush script opcode');
    if (length > bytes.length - i) throw new Error('truncated script push payload');
    last = bytes.subarray(i, i + length);
    i += length;
  }
  return last;
}

export class Ledger {
  constructor({ network, previousHash, startHeight = ACTIVATION[network], mode = 'complete', undoLimit = 128 } = {}) {
    if (!(network in ACTIVATION)) throw new Error('unsupported network');
    if (!['complete', 'sample'].includes(mode)) throw new Error('invalid coverage mode');
    integer(startHeight, 'start height');
    if (startHeight < 1) throw new Error('start height must be positive');
    if (mode === 'complete' && startHeight > ACTIVATION[network]) throw new Error('start after activation requires sample mode');
    if (!Number.isSafeInteger(undoLimit) || undoLimit < 1) throw new Error('invalid undo limit');
    this.network = network;
    this.mode = mode;
    this.startHeight = startHeight;
    this.undoLimit = undoLimit;
    this.tip = { height: startHeight - 1, hash: hex(previousHash, 'anchor hash', 64) };
    this.assets = new Map();
    this.names = new Map();
    this.utxos = new Map();
    this.commitments = new Map();
    this.spends = new Map();
    this.txids = new Map();
    this.gaps = [];
    this.history = [];
    this.journal = null;
  }

  balance(outpoint, id) { return this.utxos.get(outpoint)?.balances.get(id) ?? 0n; }

  // Record the pre-block value once. This also makes partial block failure atomic.
  set(map, key, value) {
    let touched = this.journal.changes.get(map);
    if (!touched) { touched = new Map(); this.journal.changes.set(map, touched); }
    if (!touched.has(key)) touched.set(key, map.has(key) ? clone(map.get(key)) : undefined);
    if (value === undefined) map.delete(key);
    else map.set(key, value);
  }

  restore(journal) {
    for (const [map, entries] of journal.changes) {
      for (const [key, value] of entries) {
        if (value === undefined) map.delete(key);
        else map.set(key, value);
      }
    }
    this.tip = journal.tip;
    this.gaps = journal.gaps;
  }

  rollback() {
    if (this.journal) throw new Error('cannot rollback during block application');
    const journal = this.history.pop();
    if (!journal) throw new Error('rollback beyond retained history; replay the archive');
    const removed = { ...this.tip };
    this.restore(journal);
    return removed;
  }

  applyBlock(block) {
    if (this.journal) throw new Error('nested block application');
    integer(block.height, 'block height');
    hex(block.hash, 'block hash', 64);
    hex(block.previousblockhash, 'parent hash', 64);
    if (!Array.isArray(block.tx)) throw new Error('block lacks decoded transactions');
    if (block.height <= this.tip.height) throw new Error('block height must advance');
    if (block.height !== this.tip.height + 1 && this.mode === 'complete') throw new Error('block heights must be contiguous');
    if (block.height === this.tip.height + 1 && block.previousblockhash !== this.tip.hash) throw new Error('block parent mismatch');
    if (block.txIndexes && this.mode !== 'sample') throw new Error('sparse transaction indexes require sample mode');
    if (block.txIndexes && block.txIndexes.length !== block.tx.length) throw new Error('sparse index count mismatch');
    const journal = { tip: { ...this.tip }, gaps: clone(this.gaps), changes: new Map() };
    this.journal = journal;
    try {
      if (block.height > this.tip.height + 1) this.gaps.push({ from: this.tip.height + 1, to: block.height - 1 });
      let previousIndex = -1;
      const events = [];
      for (let position = 0; position < block.tx.length; position++) {
        const index = block.txIndexes?.[position] ?? position;
        integer(index, 'transaction index');
        if (index <= previousIndex) throw new Error('transaction indexes must ascend');
        previousIndex = index;
        events.push(...this.applyTransaction(block.tx[position], block, index));
      }
      this.assertSupply();
      this.tip = { height: block.height, hash: block.hash };
      this.history.push(journal);
      if (this.history.length > this.undoLimit) this.history.shift();
      return { ...this.tip, events };
    } catch (error) {
      this.restore(journal);
      throw error;
    } finally { this.journal = null; }
  }

  maturedCommitment(tx, name, block) {
    const input = tx.vin[0];
    if (!input?.txid) return false;
    let redeem;
    try { redeem = lastScriptPush(input.scriptSig?.hex ?? ''); }
    catch { return false; }
    if (!redeem || redeem.length !== 69 || redeem[0] !== 32 || redeem[33] !== 117 || redeem[34] !== 33 || ![2, 3].includes(redeem[35]) || redeem[68] !== 172) return false;
    if (!redeem.subarray(1, 33).equals(commitmentHash(name))) return false;
    const key = outputKey(input.txid, input.vout);
    let previous = this.commitments.get(key);
    if (!previous) {
      const matches = (block.commitmentPrevouts ?? []).filter((item) => item.txid === input.txid && item.vout === input.vout);
      if (matches.length !== 1) throw new Error(`missing or ambiguous commitment prevout ${key}`);
      const item = matches[0];
      integer(item.height, 'commitment height');
      previous = { height: item.height, script: hex(item.scriptPubKey?.hex, 'commitment script') };
      // A complete scan can import only earlier history, never bypass a missing in-range output.
      if (this.mode === 'complete' && previous.height >= this.startHeight) throw new Error('missing commitment within complete replay');
    }
    if (previous.height >= block.height || block.height - previous.height < 6) return false;
    return previous.script === `a914${hash('ripemd160', hash('sha256', redeem)).toString('hex')}87`;
  }

  applyTransaction(tx, block, index) {
    hex(tx.txid, 'transaction id', 64);
    if (this.txids.has(tx.txid)) throw new Error('duplicate transaction');
    if (!Array.isArray(tx.vin) || !Array.isArray(tx.vout)) throw new Error('transaction lacks decoded inputs or outputs');
    for (let n = 0; n < tx.vout.length; n++) {
      const out = tx.vout[n];
      if (out.n !== n) throw new Error('output indexes must be contiguous');
      hex(out.scriptPubKey?.hex, 'output script');
      if (!(typeof out.valueZat === 'string' && /^(0|[1-9][0-9]*)$/.test(out.valueZat)) && !(Number.isSafeInteger(out.valueZat) && out.valueZat >= 0)) throw new Error('output requires exact nonnegative valueZat');
    }
    const active = block.height >= ACTIVATION[this.network];
    const message = active ? decode(tx.vout) : { kind: 'absent', fields: new Map(), edicts: [], ambiguity: [] };
    if (message.ambiguity?.length) throw new Error(`unresolved protocol interpretation: ${message.ambiguity.join('; ')}`);
    const events = [];
    const pool = new Map();
    const addPool = (id, amount) => pool.set(id, checked((pool.get(id) ?? 0n) + amount));
    const value = (tag, fallback = 0n) => message.fields.get(BigInt(tag))?.[0] ?? fallback;
    let etchedId;
    if (active && (value(2) & 1n) && message.fields.has(4n)) {
      let name;
      try { name = decodeName(value(4)); } catch { /* Invalid names do not consume a name. */ }
      if (name && /^[A-Z]{4,26}$/.test(name) && !this.names.has(name) && this.maturedCommitment(tx, value(4), block)) {
        etchedId = `${block.height}:${index}`;
        const malformed = message.kind === 'malformed';
        const terms = !malformed && Boolean(value(2) & 2n);
        const asset = {
          id: etchedId, name, etchTxid: tx.txid, etchHeight: block.height,
          divisibility: malformed ? 0 : Number(value(10)),
          premine: malformed ? 0n : value(12), amount: terms ? value(14) : 0n,
          cap: terms ? value(16) : 0n, start: terms ? Number(value(18, BigInt(block.height) + 1n)) : null,
          end: terms && message.fields.has(20n) ? Number(value(20)) : null,
          mints: 0n, burned: 0n, closed: malformed || !terms,
        };
        this.set(this.assets, etchedId, asset);
        this.set(this.names, name, etchedId);
        addPool(etchedId, asset.premine);
        events.push({ kind: 'etch', id: etchedId, closed: asset.closed });
      }
    }
    for (const input of tx.vin) {
      if ('coinbase' in input) continue;
      hex(input.txid, 'input transaction id', 64);
      integer(input.vout, 'input output index');
      if (input.scriptSig?.hex !== undefined) hex(input.scriptSig.hex, 'input script');
      const key = outputKey(input.txid, input.vout);
      if (this.spends.has(key)) throw new Error('duplicate or double-spent input');
      this.set(this.spends, key, block.height);
      for (const [id, amount] of this.utxos.get(key)?.balances ?? []) addPool(id, amount);
      this.set(this.utxos, key, undefined);
      this.set(this.commitments, key, undefined);
    }
    const mint = message.fields.get(24n);
    if (active && mint?.length === 2) {
      const id = mint.join(':');
      const current = this.assets.get(id);
      if (current && !current.closed && block.height >= current.start && (current.end === null || block.height <= current.end) && current.mints < current.cap) {
        const asset = clone(current);
        asset.mints++;
        this.set(this.assets, id, asset);
        addPool(id, asset.amount);
        events.push({ kind: 'mint', id, amount: asset.amount.toString(), burned: message.kind === 'malformed' });
      }
    }
    const allocations = new Map();
    const allocate = (id, amount, output) => {
      if (!amount) return;
      pool.set(id, pool.get(id) - amount);
      if (!tx.vout[output] || !transparent(tx.vout[output])) {
        const asset = clone(this.assets.get(id));
        asset.burned = checked(asset.burned + amount);
        this.set(this.assets, id, asset);
        events.push({ kind: 'burn', id, amount: amount.toString() });
      } else {
        if (!allocations.has(output)) allocations.set(output, new Map());
        const balances = allocations.get(output);
        balances.set(id, checked((balances.get(id) ?? 0n) + amount));
      }
    };
    if (message.kind === 'malformed') {
      for (const [id, amount] of pool) allocate(id, amount, -1);
    } else {
      for (const edict of message.edicts) {
        const id = edict.block === 0n && edict.tx === 0n ? etchedId : `${edict.block}:${edict.tx}`;
        const available = pool.get(id) ?? 0n;
        const amount = edict.amount === 0n || edict.amount > available ? available : edict.amount;
        allocate(id, amount, Number(edict.output));
      }
      const pointer = message.fields.has(22n) ? Number(value(22)) : tx.vout.findIndex(transparent);
      for (const [id, amount] of pool) allocate(id, amount, pointer);
    }
    for (const [output, balances] of allocations) this.set(this.utxos, outputKey(tx.txid, output), { script: tx.vout[output].scriptPubKey.hex, balances });
    for (const output of tx.vout) {
      if (/^a914[0-9a-f]{40}87$/.test(output.scriptPubKey.hex)) this.set(this.commitments, outputKey(tx.txid, output.n), { height: block.height, script: output.scriptPubKey.hex });
    }
    this.set(this.txids, tx.txid, block.height);
    return events;
  }

  supplies() {
    const totals = new Map();
    for (const { balances } of this.utxos.values()) {
      for (const [id, amount] of balances) {
        if (!this.assets.has(id)) throw new Error('balance for unknown asset');
        totals.set(id, checked((totals.get(id) ?? 0n) + amount));
      }
    }
    return totals;
  }

  assertSupply() {
    const totals = this.supplies();
    for (const [id, asset] of this.assets) {
      const supply = checked(asset.premine + asset.mints * asset.amount);
      if (asset.mints > asset.cap || supply !== (totals.get(id) ?? 0n) + asset.burned) throw new Error(`supply invariant failed: ${id}`);
    }
  }

  snapshot() {
    const totals = this.supplies();
    return {
      schema: 'zec-market-zrunes-ledger-v1', protocol: 'zrunes-v1', network: this.network,
      tip: { ...this.tip }, coverage: { mode: this.mode, complete: this.mode === 'complete', from: this.startHeight, to: this.tip.height, gaps: clone(this.gaps) },
      assets: [...this.assets.values()].map((asset) => ({
        ...asset, premine: asset.premine.toString(), amount: asset.amount.toString(), cap: asset.cap.toString(),
        mints: asset.mints.toString(), burned: asset.burned.toString(),
        supply: (asset.premine + asset.mints * asset.amount).toString(), circulating: (totals.get(asset.id) ?? 0n).toString(),
      })).sort((a, b) => a.etchHeight - b.etchHeight || Number(a.id.split(':')[1]) - Number(b.id.split(':')[1])),
      outputs: [...this.utxos].map(([outpoint, entry]) => ({ outpoint, script: entry.script, balances: Object.fromEntries([...entry.balances].map(([id, amount]) => [id, amount.toString()])) })).sort((a, b) => a.outpoint.localeCompare(b.outpoint)),
    };
  }
}
