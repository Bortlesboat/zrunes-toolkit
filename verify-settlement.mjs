import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readArchive, replay } from './replay.mjs';

export function verifySettlement(directory, requireRpc = true) {
  const read = (name) => JSON.parse(readFileSync(join(directory, name), 'utf8').replace(/^\uFEFF/, ''));
  const receipt = read('receipt.json');
  const archive = readArchive(join(directory, 'replay.json'));
  const ledger = replay(archive);
  const snapshot = ledger.snapshot();
  assert.equal(receipt.network, 'regtest');
  assert.equal(archive.network, 'regtest');
  assert.equal(archive.previousHash, receipt.genesis);
  assert.equal(snapshot.coverage.complete, true);
  assert.equal(snapshot.coverage.from, 1);
  assert.equal(snapshot.tip.height, 110);
  assert.equal(receipt.quantity, '1000000000000000001');
  assert.equal(receipt.price_zat, 100000000);
  assert.equal(receipt.fee_zat, 30000);
  assert.equal(snapshot.assets.length, 1);
  assert.equal(snapshot.assets[0].id, '108:1');
  assert.equal(snapshot.assets[0].supply, receipt.quantity);
  assert.equal(snapshot.assets[0].burned, '0');
  assert.equal(snapshot.outputs.length, 1);
  assert.equal(ledger.balance(receipt.buyer_outpoint, '108:1'), BigInt(receipt.quantity));
  assert.equal(snapshot.outputs[0].script, receipt.buyer_script);
  const transactions = new Map(archive.blocks.flatMap((block) => block.tx.map((tx) => [tx.txid, tx])));
  const [saleId, buyerIndex] = receipt.buyer_outpoint.split(':');
  assert.equal(buyerIndex, '1');
  const sale = transactions.get(saleId);
  assert.ok(sale);
  const outpoint = (coin) => `${coin.txid}:${coin.vout}`;
  const beforeSale = replay({ ...archive, blocks: archive.blocks.filter((block) => block.height < 110) });
  assert.equal(beforeSale.balance(outpoint(sale.vin[0]), '108:1'), BigInt(receipt.quantity), 'sale input 0 owns the entire token lot');
  assert.equal(transactions.get(sale.vin[0].txid).vout[sale.vin[0].vout].scriptPubKey.hex,
    sale.vout[0].scriptPubKey.hex, 'seller payment returns to the token owner');
  assert.equal(transactions.get(sale.vin[1].txid).vout[sale.vin[1].vout].scriptPubKey.hex,
    sale.vout[1].scriptPubKey.hex, 'buyer output returns to the funding owner');
  assert.equal(sale.vout[0].scriptPubKey.hex, receipt.seller_payment_script);
  const inputValues = sale.vin.map((input) => BigInt(transactions.get(input.txid).vout[input.vout].valueZat));
  const outputValues = sale.vout.map((output) => BigInt(output.valueZat));
  assert.equal(outputValues[0], 100000000n + inputValues[0], 'seller receives full price and carrier refund');
  assert.equal(inputValues.reduce((a, b) => a + b, 0n) - outputValues.reduce((a, b) => a + b, 0n), 30000n);
  assert.equal(inputValues[1] - outputValues[1], 100030000n, 'buyer pays price and fee');
  assert.equal(readFileSync(join(directory, 'sale.hex'), 'utf8'), readFileSync(join(directory, 'recovered-sale.hex'), 'utf8'));
  const recovery = read('recovery.json');
  assert.equal(recovery.txid, saleId);
  assert.equal(recovery.confirmed, true);
  assert.equal(recovery.raw_match, true);
  for (const name of ['altered-payment-node-rejection', 'cancelled-offer-node-rejection', 'competing-sale-node-rejection']) {
    const rejection = receipt.rejections.find((item) => item.check === name);
    const error = rejection?.rpc_response?.error;
    assert.equal(error?.code, -25, `${name}: rejection code`);
    assert.equal(typeof error?.message, 'string', `${name}: rejection message`);
    assert.match(error.message, name.startsWith('altered') ? /ScriptInvalid/ : /could not find transparent input UTXO/, `${name}: rejection message`);
  }
  if (requireRpc) {
    const rpcArchive = readArchive(join(directory, 'rpc-replay.json'));
    assert.equal(rpcArchive.genesisHash, receipt.genesis);
    assert.deepEqual(replay(rpcArchive).snapshot(), snapshot, 'live RPC and native export reconstruct identical state');
    assert.deepEqual(read('rpc-ledger.json'), snapshot);
  }
  const stalePolicy = read('stale-policy.json');
  const competingPolicy = read('competing-policy.json');
  const buyerPolicy = read('buyer-policy.json');
  const funding = receipt.rejection_funding;
  assert.ok(funding && typeof funding === 'object', 'rejection funding evidence required');
  assert.ok(funding.coin && typeof funding.coin === 'object', 'rejection funding coin required');
  assert.deepEqual(funding.coin, stalePolicy.funding, 'cancelled offer uses alternate funding');
  assert.deepEqual(funding.coin, competingPolicy.funding, 'competing sale uses alternate funding');
  assert.notEqual(outpoint(funding.coin), outpoint(buyerPolicy.funding), 'rejection funding differs from accepted sale funding');
  const checkCoin = (coin, label) => {
    const output = transactions.get(coin.txid)?.vout[coin.vout];
    assert.ok(output, `${label}: coin exists in confirmed archive`);
    assert.equal(BigInt(coin.value_zat), BigInt(output.valueZat), `${label}: confirmed value`);
    assert.equal(coin.script, output.scriptPubKey.hex, `${label}: confirmed script`);
  };
  for (const [name, policy, proposalFile] of [
    ['cancelled offer', stalePolicy, 'stale-proposal.json'],
    ['competing sale', competingPolicy, 'competing-proposal.json'],
    ['accepted sale', buyerPolicy, 'proposal.json'],
  ]) {
    checkCoin(policy.asset, `${name} asset`);
    checkCoin(policy.funding, `${name} funding`);
    assert.deepEqual(read(proposalFile).inputs, [policy.asset, policy.funding], `${name}: proposal inputs match policy`);
  }
  assert.deepEqual(sale.vin.map(outpoint), [buyerPolicy.asset, buyerPolicy.funding].map(outpoint), 'confirmed sale inputs match buyer policy');
  const spentBy = new Map();
  for (const tx of transactions.values()) for (const input of tx.vin) {
    if (!input.txid) continue;
    const key = outpoint(input);
    spentBy.set(key, [...(spentBy.get(key) ?? []), tx.txid]);
  }
  assert.equal(spentBy.has(outpoint(funding.coin)), false, 'rejection funding remains unspent throughout confirmed archive');
  for (const phase of ['before', 'after']) {
    const observed = funding[phase];
    assert.ok(observed && typeof observed === 'object', `rejection funding ${phase}: unspent gettxout required`);
    assert.equal(observed.scriptPubKey?.hex, funding.coin.script, `rejection funding ${phase}: gettxout script`);
  }
  assert.deepEqual(competingPolicy.asset, buyerPolicy.asset, 'competing sale targets accepted token input');
  assert.ok(buyerPolicy.ancestors.includes(buyerPolicy.asset.txid), 'cancellation is an accepted sale ancestor');
  assert.deepEqual(spentBy.get(outpoint(stalePolicy.asset)), [buyerPolicy.asset.txid], 'cancellation consumes the stale token input');
  assert.deepEqual(spentBy.get(outpoint(competingPolicy.asset)), [saleId], 'accepted sale consumes the competing token input');
  for (const [name, policy] of [['cancelled_offer', stalePolicy], ['competing_sale', competingPolicy]]) {
    const observed = receipt.rejection_assets?.[name];
    assert.deepEqual(observed?.coin, policy.asset, `${name}: spent token coin evidence`);
    assert.equal(observed?.gettxout, null, `${name}: token gettxout must be null`);
  }
  const hashes = Object.fromEntries(['codec.mjs', 'ledger.mjs', 'replay.mjs', 'verify-settlement.mjs'].map((name) => [name, createHash('sha256').update(readFileSync(new URL(name, import.meta.url))).digest('hex')]));
  return { schema: 'zrunes-independent-settlement-check-v1', checkedAt: new Date().toISOString(), nodeRun: directory.split(/[\\/]/).at(-1),
    liveRpcCompared: requireRpc, blocksReplayed: archive.blocks.length, tip: snapshot.tip, asset: snapshot.assets[0],
    buyerOutpoint: receipt.buyer_outpoint, sellerPaymentZatoshis: outputValues[0].toString(), buyerDebitZatoshis: '100030000',
    rejectionChecks: 3, rejectionFundingIsolated: true, recoveredTransactionIdentical: true, sourceSha256: hashes,
    scope: 'Local regtest consensus acceptance plus independent token accounting; public fixture keys and same-host processes, not production wallet security.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node verify-settlement.mjs EVIDENCE_DIRECTORY');
    const directory = resolve(process.argv[2]);
    const result = verifySettlement(directory);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
