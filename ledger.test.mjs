import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Ledger } from './ledger.mjs';
import { encode, encodeName, commitmentHash } from './codec.mjs';

const h = (n) => n.toString(16).padStart(64, '0');
const pay = `76a914${'11'.repeat(20)}88ac`;
const other = `76a914${'22'.repeat(20)}88ac`;
const fields = (values) => new Map(Object.entries(values).map(([k, v]) => [BigInt(k), (Array.isArray(v) ? v : [v]).map(BigInt)]));
const out = (hex, n = 0, valueZat = 546) => ({ n, valueZat, scriptPubKey: { hex } });
const tx = (n, inputs, scripts) => ({ txid: h(n), vin: inputs, vout: scripts.map((s, i) => out(s, i, s.startsWith('6a') ? 0 : 546)) });
const input = (n, vout = 0, hex = '') => ({ txid: h(n), vout, scriptSig: { hex } });
const block = (height, transactions = [], hash = h(height), prev = h(height - 1)) => ({ height, hash, previousblockhash: prev, tx: transactions });

function fixture({ premine = 100n, terms = {} } = {}) {
  const ledger = new Ledger({ network: 'regtest', previousHash: h(0) });
  const name = encodeName('TEST');
  const redeem = Buffer.concat([Buffer.from([32]), commitmentHash(name), Buffer.from([117, 33, 2]), Buffer.alloc(32, 3), Buffer.from([172])]);
  const digest = createHash('ripemd160').update(createHash('sha256').update(redeem).digest()).digest('hex');
  const commit = tx(1001, [{ coinbase: '00' }], [`a914${digest}87`]);
  ledger.applyBlock(block(1, [commit]));
  for (let height = 2; height <= 6; height++) ledger.applyBlock(block(height));
  const etchFields = fields({ 2: Object.keys(terms).length ? 3 : 1, 4: name, 12: premine, ...terms });
  const etch = tx(1007, [input(1001, 0, `00${redeem.length.toString(16)}${redeem.toString('hex')}`)], [pay, encode(etchFields)]);
  ledger.applyBlock(block(7, [etch]));
  return { ledger, etch, commit, redeem, name };
}

test('mature commitment issues exact premine; ordinary spend moves it without a carrier', () => {
  const { ledger } = fixture();
  assert.equal(ledger.balance(`${h(1007)}:0`, '7:0'), 100n);
  ledger.applyBlock(block(8, [tx(1008, [input(1007)], ['6a01ff', other])]));
  assert.equal(ledger.balance(`${h(1007)}:0`, '7:0'), 0n);
  assert.equal(ledger.balance(`${h(1008)}:1`, '7:0'), 100n);
  assert.equal(ledger.snapshot().assets[0].circulating, '100');
});

for (const [label, prefix] of [['direct', '45'], ['PUSHDATA1', '4c45'], ['PUSHDATA2', '4d4500'], ['PUSHDATA4', '4e45000000']]) {
  test(`mature commitment has identical issuance with a ${label} redeem push`, () => {
    const { ledger, etch, redeem } = fixture({ terms: { 14: 10, 16: 2 } });
    const expected = ledger.snapshot();
    ledger.rollback();
    etch.vin[0].scriptSig.hex = `00${prefix}${redeem.toString('hex')}`;
    ledger.applyBlock(block(7, [etch]));
    assert.deepEqual(ledger.snapshot(), expected);
  });
}

test('commitment scriptSig accepts preceding OP_0, OP_1NEGATE and OP_1 through OP_16', () => {
  for (const opcode of [0x00, 0x4f, ...Array.from({ length: 16 }, (_, n) => 0x51 + n)]) {
    const { ledger, etch, redeem } = fixture();
    ledger.rollback();
    etch.vin[0].scriptSig.hex = `${opcode.toString(16).padStart(2, '0')}45${redeem.toString('hex')}`;
    ledger.applyBlock(block(7, [etch]));
    assert.equal(ledger.balance(`${h(1007)}:0`, '7:0'), 100n, `opcode ${opcode.toString(16)}`);
  }
});

test('commitment scriptSig rejects truncated framing without recovering an earlier redeem push', () => {
  const { ledger, etch, redeem } = fixture();
  ledger.rollback();
  const bytes = redeem.toString('hex');
  const valid = `45${bytes}`;
  const scripts = [
    ...['4c', '4d', '4d45', '4e', '4e45', '4e4500', '4e450000', '01'].map((tail) => valid + tail),
    ...['46', '4c46', '4d4600', '4e46000000', '4dffff', '4effffffff'].map((prefix) => prefix + bytes),
  ];
  for (const script of scripts) {
    etch.vin[0].scriptSig.hex = script;
    ledger.applyBlock(block(7, [etch]));
    assert.equal(ledger.snapshot().assets.length, 0, script);
    ledger.rollback();
  }
});

test('commitment scriptSig rejects nonpush opcodes and requires the redeem script to be last', () => {
  const { ledger, etch, redeem } = fixture();
  ledger.rollback();
  const valid = `45${redeem.toString('hex')}`;
  for (const script of ['50', '61', '76', '6a'].flatMap((opcode) => [opcode + valid, valid + opcode]).concat([valid + '00', valid + '4f', valid + '51', valid + '60'])) {
    etch.vin[0].scriptSig.hex = script;
    ledger.applyBlock(block(7, [etch]));
    assert.equal(ledger.snapshot().assets.length, 0, script);
    ledger.rollback();
  }
});

test('commitment reader strictly validates scriptSig hex before decoding bytes', () => {
  const { ledger, etch, name } = fixture();
  ledger.rollback();
  const valid = etch.vin[0].scriptSig.hex;
  const before = ledger.snapshot();
  for (const script of [valid + '0', valid + 'zz', valid + ' ', '0x' + valid]) {
    etch.vin[0].scriptSig.hex = script;
    assert.equal(ledger.maturedCommitment(etch, name, block(7)), false, script);
    assert.throws(() => ledger.applyBlock(block(7, [etch])), /invalid input script/);
    assert.deepEqual(ledger.snapshot(), before);
  }
});

test('mature malformed etch consumes its name with zero premine and permanently closed terms', () => {
  const { ledger, etch, commit, name } = fixture({ terms: { 14: 10, 16: 2 } });
  ledger.rollback();
  const retry = structuredClone(etch);
  retry.txid = h(1013);
  retry.vin[0].txid = h(1002);
  // Append a complete unknown even field (26, 1); framing and NAME remain unambiguous.
  etch.vout[1].scriptPubKey.hex += '021a01';
  const replacementCommit = { ...commit, txid: h(1002) };
  ledger.applyBlock(block(7, [etch, replacementCommit]));
  const asset = ledger.snapshot().assets[0];
  assert.equal(asset.name, 'TEST');
  assert.equal(asset.premine, '0');
  assert.equal(asset.supply, '0');
  assert.equal(asset.amount, '0');
  assert.equal(asset.cap, '0');
  assert.equal(asset.closed, true);
  assert.equal(asset.start, null);
  assert.equal(asset.end, null);
  for (let height = 8; height <= 12; height++) {
    ledger.applyBlock(block(height, [tx(2000 + height, [], [pay, encode(fields({ 24: [7, 0] }))])]));
  }
  assert.equal(ledger.maturedCommitment(retry, name, block(13)), true);
  ledger.applyBlock(block(13, [retry]));
  assert.deepEqual(ledger.snapshot().assets, [asset]);
  assert.deepEqual(ledger.snapshot().outputs, []);
});

test('edict splits a lot and a pointer allocates change exactly', () => {
  const { ledger } = fixture();
  const carrier = encode(fields({ 22: 1 }), [{ block: 7n, tx: 0n, amount: 25n, output: 0n }]);
  ledger.applyBlock(block(8, [tx(1008, [input(1007)], [other, pay, carrier])]));
  assert.equal(ledger.balance(`${h(1008)}:0`, '7:0'), 25n);
  assert.equal(ledger.balance(`${h(1008)}:1`, '7:0'), 75n);
});

test('missing output pointer and no transparent successor burn tokens', () => {
  for (const scripts of [[pay, encode(fields({ 22: 99 }))], ['6a01ff']]) {
    const { ledger } = fixture();
    ledger.applyBlock(block(8, [tx(1008, [input(1007)], scripts)]));
    const asset = ledger.snapshot().assets[0];
    assert.equal(asset.burned, '100');
    assert.equal(asset.circulating, '0');
  }
});

test('unambiguous malformed carrier burns incoming tokens', () => {
  const { ledger } = fixture();
  ledger.applyBlock(block(8, [tx(1008, [input(1007)], [pay, '6a5e021a01'])]));
  assert.equal(ledger.snapshot().assets[0].burned, '100');
});

test('mint window and cap count valid and malformed successful mint attempts', () => {
  const { ledger } = fixture({ premine: 0n, terms: { 14: 10, 16: 2, 18: 9, 20: 10 } });
  const mint = encode(fields({ 24: [7, 0] }));
  ledger.applyBlock(block(8, [tx(1008, [], [pay, mint])]));
  assert.equal(ledger.snapshot().assets[0].mints, '0');
  ledger.applyBlock(block(9, [tx(1009, [], [pay, mint])]));
  // MINT(24,7,0) followed by unknown even field(26,1).
  ledger.applyBlock(block(10, [tx(1010, [], [pay, '6a5e051807001a01']), tx(1011, [], [pay, mint])]));
  const asset = ledger.snapshot().assets[0];
  assert.equal(asset.mints, '2');
  assert.equal(asset.supply, '20');
  assert.equal(asset.circulating, '10');
  assert.equal(asset.burned, '10');
});

test('rollback restores outpoints, mint capacity and commitment state; alternative branch agrees', () => {
  const { ledger } = fixture({ terms: { 14: 10, 16: 1 } });
  const before = ledger.snapshot();
  ledger.applyBlock(block(8, [tx(1008, [input(1007)], [other, encode(fields({ 24: [7, 0] }))])]));
  ledger.rollback();
  assert.deepEqual(ledger.snapshot(), before);
  ledger.applyBlock(block(8, [tx(1009, [input(1007)], ['6a01ff'])], h(808)));
  assert.equal(ledger.snapshot().assets[0].burned, '100');
  assert.equal(ledger.snapshot().assets[0].mints, '0');
});

test('bad chain, duplicate input and repeated transaction fail atomically', () => {
  const { ledger } = fixture();
  const before = ledger.snapshot();
  assert.throws(() => ledger.applyBlock(block(9)), /height|contiguous/);
  assert.throws(() => ledger.applyBlock(block(8, [], h(8), h(999))), /parent/);
  const spend = tx(1008, [input(1007)], [other]);
  assert.throws(() => ledger.applyBlock(block(8, [spend, spend])), /duplicate/);
  assert.throws(() => ledger.applyBlock(block(8, [tx(1008, [input(1007), input(1007)], [other])])), /double|duplicate/);
  assert.deepEqual(ledger.snapshot(), before);
});

test('commitment must mature; rollback etch makes its name and commitment reusable', () => {
  const { ledger, etch } = fixture();
  ledger.rollback();
  assert.equal(ledger.snapshot().assets.length, 0);
  ledger.applyBlock(block(7, [etch], h(707)));
  assert.equal(ledger.snapshot().assets[0].name, 'TEST');
  const young = new Ledger({ network: 'regtest', previousHash: h(0) });
  const { commit } = fixture();
  young.applyBlock(block(1, [commit]));
  young.applyBlock(block(2, [etch]));
  assert.equal(young.snapshot().assets.length, 0);
});

test('sampling exposes omitted blocks and explicit transaction positions', () => {
  const { etch, commit } = fixture();
  const ledger = new Ledger({ network: 'regtest', mode: 'sample', previousHash: h(0) });
  ledger.applyBlock(block(1, [commit]));
  ledger.applyBlock({ ...block(7, [etch]), txIndexes: [5] });
  const snap = ledger.snapshot();
  assert.equal(snap.coverage.complete, false);
  assert.deepEqual(snap.coverage.gaps, [{ from: 2, to: 6 }]);
  assert.equal(snap.assets[0].id, '7:5');
  assert.throws(() => new Ledger({ network: 'regtest', startHeight: 10, previousHash: h(9) }), /activation|sample/);
});
