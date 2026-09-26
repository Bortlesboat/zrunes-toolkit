// Reproduce the bounded evidence comparison. Operator data is comparison-only.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ledger } from '../../ledger.mjs';
import { decode } from '../../codec.mjs';

const read = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url)));
const digest = (relative) => createHash('sha256').update(readFileSync(new URL(relative, import.meta.url))).digest('hex');
const bundle = read('./sample-bundle.json');
const expected = read('./operator-expected.json');
const classifications = [];
const classificationByTxid = new Map();
const ordinaryBalanceSpends = [];
class ObservedLedger extends Ledger {
  applyTransaction(tx, block, index) {
    if (classificationByTxid.get(tx.txid) === 'absent' && tx.vin.some((input) => this.utxos.has(`${input.txid}:${input.vout}`))) ordinaryBalanceSpends.push(tx.txid);
    return super.applyTransaction(tx, block, index);
  }
}
const ledger = new ObservedLedger(bundle);
const events = [];
const addressByScript = new Map();
for (const block of bundle.blocks) {
  for (let i = 0; i < block.tx.length; i++) {
    const tx = block.tx[i];
    const decoded = decode(tx.vout);
    classificationByTxid.set(tx.txid, decoded.kind);
    classifications.push({ txid: tx.txid, height: block.height, index: block.txIndexes[i], kind: decoded.kind, errors: decoded.errors });
    for (const output of tx.vout) {
      if (output.scriptPubKey.addresses?.length === 1) addressByScript.set(output.scriptPubKey.hex, output.scriptPubKey.addresses[0]);
    }
  }
  events.push(...ledger.applyBlock(block).events);
}
const snapshot = ledger.snapshot();
const mismatches = [];
let assertions = 0;
const equal = (subject, actual, wanted) => {
  assertions++;
  if (actual !== wanted) mismatches.push({ subject, actual, expected: wanted });
};
equal('token count', snapshot.assets.length, expected.tokensSnapshot.items.length);
for (const wanted of expected.tokensSnapshot.items) {
  const actual = snapshot.assets.find((asset) => asset.id === wanted.id);
  if (!actual) { mismatches.push({ subject: wanted.id, error: 'missing asset' }); continue; }
  for (const [field, value] of Object.entries({ name: wanted.name, etchTxid: wanted.etch_txid,
    etchHeight: Number(wanted.etch_height), divisibility: Number(wanted.divisibility), premine: wanted.premine,
    amount: wanted.amount ?? '0', cap: wanted.cap ?? '0', mints: wanted.mints_completed,
    supply: wanted.supply, circulating: wanted.circulating, burned: wanted.burned, closed: wanted.closed })) {
    equal(`${wanted.id}.${field}`, actual[field], value);
  }
}
for (const holders of expected.holderSnapshots) {
  const balances = new Map();
  const counts = new Map();
  for (const output of snapshot.outputs) {
    const balance = output.balances[holders.zrune_id];
    if (balance === undefined) continue;
    const address = addressByScript.get(output.script);
    balances.set(address, (balances.get(address) ?? 0n) + BigInt(balance));
    counts.set(address, (counts.get(address) ?? 0) + 1);
  }
  equal(`${holders.zrune_id}.holder count`, balances.size, holders.items.length);
  for (const holder of holders.items) {
    equal(`${holders.zrune_id}.${holder.address}.balance`, balances.get(holder.address)?.toString(), holder.balance);
    equal(`${holders.zrune_id}.${holder.address}.outpoints`, String(counts.get(holder.address)), holder.outpoints);
  }
}
const unspentChecks = [];
for (const output of snapshot.outputs) {
  const [txid, index] = output.outpoint.split(':');
  const details = read(`./raw/tx-${txid}-details.json`);
  const source = read(`./raw/tx-${txid}-details.source.json`);
  const observed = details.outputs.find((item) => item.vout_index === Number(index));
  equal(`${output.outpoint}.independently reported spent`, observed?.spent, false);
  unspentChecks.push({ outpoint: output.outpoint, spent: observed.spent, url: source.url, observedAt: source.observedAt });
}
const receipt = {
  generatedAt: new Date().toISOString(), mode: 'sample', chainComplete: false,
  implementation: { ledgerSha256: digest('../../ledger.mjs'), codecSha256: digest('../../codec.mjs'), bundleSha256: digest('./sample-bundle.json') },
  decodedTransactions: classifications.length,
  classifications: { valid: classifications.filter((x) => x.kind === 'valid').length, malformed: classifications.filter((x) => x.kind === 'malformed').length, absent: classifications.filter((x) => x.kind === 'absent').length },
  comparedAssertions: assertions, mismatches, ordinaryBalanceSpends,
  limitation: 'Sample dependency coverage for the discovered balances; neither exhaustive activation-to-tip scanning nor independent Zcash consensus verification.',
  unspentChecks, snapshot, carrierDetails: classifications.filter((x) => x.kind !== 'absent'), events,
};
console.log(JSON.stringify({ mode: receipt.mode, decodedTransactions: receipt.decodedTransactions, classifications: receipt.classifications,
  comparedAssertions: assertions, mismatchCount: mismatches.length, assets: snapshot.assets.length, outputs: snapshot.outputs.length, ordinaryBalanceSpends: ordinaryBalanceSpends.length }));
if (mismatches.length) process.exitCode = 1;
