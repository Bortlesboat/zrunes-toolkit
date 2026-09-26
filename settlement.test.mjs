import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySettlement } from './verify-settlement.mjs';

const fixture = fileURLToPath(new URL('./research/settlement/evidence/20260925T191044Z-16d6497e/', import.meta.url));
const files = ['receipt.json', 'replay.json', 'rpc-replay.json', 'rpc-ledger.json', 'sale.hex', 'recovered-sale.hex', 'recovery.json',
  'stale-policy.json', 'competing-policy.json', 'buyer-policy.json', 'stale-proposal.json', 'competing-proposal.json', 'proposal.json'];

function withCopiedEvidence(check) {
  const directory = mkdtempSync(join(tmpdir(), 'zrunes-evidence-'));
  const read = (name) => JSON.parse(readFileSync(join(directory, name), 'utf8').replace(/^\uFEFF/, ''));
  const write = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value));
  try {
    for (const file of files) copyFileSync(join(fixture, file), join(directory, file));
    check(directory, read, write);
  } finally { rmSync(directory, { recursive: true }); }
}

test('independent accounting verifies the archived real-node sale and RPC replay', () => {
  const result = verifySettlement(fixture);
  assert.equal(result.liveRpcCompared, true);
  assert.equal(result.sellerPaymentZatoshis, '100140000');
  assert.equal(result.buyerDebitZatoshis, '100030000');
  assert.equal(result.rejectionFundingIsolated, true);
});

for (const mutation of ['seller-payment', 'rpc-divergence']) {
  test(`settlement evidence rejects ${mutation}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'zrunes-evidence-'));
    try {
      for (const file of files) copyFileSync(join(fixture, file), join(directory, file));
      if (mutation === 'seller-payment') {
        const file = join(directory, 'replay.json');
        const archive = JSON.parse(readFileSync(file, 'utf8'));
        const sale = archive.blocks.at(-1).tx[1];
        sale.vout[0].valueZat = String(BigInt(sale.vout[0].valueZat) - 1n);
        writeFileSync(file, JSON.stringify(archive));
        assert.throws(() => verifySettlement(directory), /seller receives full price/);
      } else {
        const file = join(directory, 'rpc-ledger.json');
        const snapshot = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        snapshot.outputs[0].balances['108:1'] = '1';
        writeFileSync(file, JSON.stringify(snapshot));
        assert.throws(() => verifySettlement(directory), /deep-equal/);
      }
    } finally { rmSync(directory, { recursive: true }); }
  });
}

for (const name of ['altered-payment-node-rejection', 'cancelled-offer-node-rejection', 'competing-sale-node-rejection']) {
  for (const field of ['code', 'message']) for (const mutation of ['missing', 'mutated']) {
    test(`settlement evidence rejects ${name} ${mutation} ${field}`, () => withCopiedEvidence((directory, read, write) => {
      const receipt = read('receipt.json');
      const error = receipt.rejections.find((item) => item.check === name).rpc_response.error;
      if (mutation === 'missing') delete error[field];
      else error[field] = field === 'code' ? -26 : 'unrelated rejection';
      write('receipt.json', receipt);
      assert.throws(() => verifySettlement(directory), new RegExp(`${name}: rejection ${field}`));
    }));
  }
}

const isolationMutations = [
  ['missing funding evidence', (receipt) => { delete receipt.rejection_funding; }, /rejection funding evidence required/],
  ['missing funding coin', (receipt) => { delete receipt.rejection_funding.coin; }, /rejection funding coin required/],
  ['changed funding coin', (receipt) => { receipt.rejection_funding.coin.vout = 1; }, /cancelled offer uses alternate funding/],
  ...['before', 'after'].flatMap((phase) => [
    [`missing funding ${phase}`, (receipt) => { delete receipt.rejection_funding[phase]; }, new RegExp(`rejection funding ${phase}: unspent gettxout required`)],
    [`spent funding ${phase}`, (receipt) => { receipt.rejection_funding[phase] = null; }, new RegExp(`rejection funding ${phase}: unspent gettxout required`)],
    [`changed funding ${phase} script`, (receipt) => { receipt.rejection_funding[phase].scriptPubKey.hex = '51'; }, new RegExp(`rejection funding ${phase}: gettxout script`)],
  ]),
  ...['cancelled_offer', 'competing_sale'].flatMap((name) => [
    [`missing ${name} token evidence`, (receipt) => { delete receipt.rejection_assets[name]; }, new RegExp(`${name}: spent token coin evidence`)],
    [`missing ${name} token state`, (receipt) => { delete receipt.rejection_assets[name].gettxout; }, new RegExp(`${name}: token gettxout must be null`)],
    [`unspent ${name} token`, (receipt) => { receipt.rejection_assets[name].gettxout = {}; }, new RegExp(`${name}: token gettxout must be null`)],
  ]),
];
for (const [name, mutate, expected] of isolationMutations) {
  test(`settlement evidence rejects ${name}`, () => withCopiedEvidence((directory, read, write) => {
    // Each isolation mutation requires a valid regenerated native receipt first.
    assert.equal(verifySettlement(directory).rejectionFundingIsolated, true);
    const receipt = read('receipt.json');
    mutate(receipt);
    write('receipt.json', receipt);
    assert.throws(() => verifySettlement(directory), expected);
  }));
}

for (const [name, file] of [['cancelled offer', 'stale-proposal.json'], ['competing sale', 'competing-proposal.json'], ['accepted sale', 'proposal.json']]) {
  test(`settlement evidence rejects ${name} proposal input mismatch`, () => withCopiedEvidence((directory, read, write) => {
    assert.equal(verifySettlement(directory).rejectionFundingIsolated, true);
    const proposal = read(file);
    proposal.inputs[1].vout += 1;
    write(file, proposal);
    assert.throws(() => verifySettlement(directory), new RegExp(`${name}: proposal inputs match policy`));
  }));
}

for (const field of ['value_zat', 'script']) {
  test(`settlement evidence rejects correlated alternate funding ${field}`, () => withCopiedEvidence((directory, read, write) => {
    assert.equal(verifySettlement(directory).rejectionFundingIsolated, true);
    const receipt = read('receipt.json');
    const coin = receipt.rejection_funding.coin;
    coin[field] = field === 'value_zat' ? coin[field] + 1 : '51';
    write('receipt.json', receipt);
    for (const prefix of ['stale', 'competing']) {
      const policy = read(`${prefix}-policy.json`);
      const proposal = read(`${prefix}-proposal.json`);
      policy.funding = coin;
      proposal.inputs[1] = coin;
      write(`${prefix}-policy.json`, policy);
      write(`${prefix}-proposal.json`, proposal);
    }
    assert.throws(() => verifySettlement(directory), new RegExp(`cancelled offer funding: confirmed ${field === 'value_zat' ? 'value' : 'script'}`));
  }));
}
