import assert from 'node:assert/strict';
import { createHash as nodeHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { commitmentHash, decode, encode, encodeName } from '../codec.mjs';
import { Ledger } from '../ledger.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const bundle = JSON.parse(await readFile(new URL('../fixtures/mainnet/sample-bundle.json', import.meta.url), 'utf8'));
const engine = () => import('./engine.mjs');
let browserModule;

async function browser() {
  if (!browserModule) {
    const { build } = await import('esbuild');
    const result = await build({
      absWorkingDir: directory,
      stdin: {
        contents: "export * from './engine.mjs'; export { createHash } from './crypto.mjs'; export { commitmentHash } from '../codec.mjs'; export { Ledger } from '../ledger.mjs';",
        resolveDir: directory,
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      inject: [fileURLToPath(new URL('./buffer.mjs', import.meta.url))],
      alias: { 'node:crypto': fileURLToPath(new URL('./crypto.mjs', import.meta.url)) },
    });
    const source = result.outputFiles[0].text;
    assert.doesNotMatch(source, /(?:from|import\s*\()\s*['"]node:/);
    browserModule = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  }
  return browserModule;
}

function outputs(hex, count) {
  return Array.from({ length: count }, (_, n) => ({ n, valueZat: 0, scriptPubKey: { hex: n === count - 1 ? hex : '51' } }));
}

function nativeSnapshot() {
  const ledger = new Ledger(bundle);
  for (const block of bundle.blocks) ledger.applyBlock(block);
  return ledger.snapshot();
}

test('rejects malformed user input before decoding', async () => {
  const { decodeScript } = await engine();
  for (const value of ['', '  \n ', '1', '6ag0', '0x6a', 'aa'.repeat(1025), null, 42]) {
    assert.throws(() => decodeScript(value), /hex|script/i);
  }
  for (const count of [0, -1, 33, 1.5, NaN, Infinity, '3', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => decodeScript('51', count), /output count/i);
  }
  assert.equal(decodeScript('51', 1).kind, 'absent');
  assert.equal(decodeScript('51', 32).kind, 'absent');
  assert.equal(decodeScript('aa'.repeat(1024)).bytes, 1024);
});

test('normalizes whitespace and case and serializes exact integers', async () => {
  const { decodeScript } = await engine();
  const amount = 9007199254740993n;
  const hex = encode(new Map([[2n, [1n]], [4n, [encodeName('DEMO')]], [12n, [amount]]]), [{ block: 0n, tx: 0n, amount, output: 0n }]);
  const decoded = decodeScript(hex.toUpperCase().match(/.{1,2}/g).join(' \n'));
  assert.equal(decoded.kind, 'valid');
  assert.equal(decoded.name, 'DEMO');
  assert.equal(decoded.dataOutput, 2);
  assert.equal(decoded.bytes, hex.length / 2);
  assert.equal(decoded.fields.find(({ tag }) => tag === '12').values[0], amount.toString());
  assert.deepEqual(decoded.edicts, [{ id: '0:0', amount: amount.toString(), output: '0' }]);
  assert.doesNotThrow(() => JSON.stringify(decoded));
});

test('synthetic output context controls carrier and allocation bounds', async () => {
  const { decodeScript } = await engine();
  const hex = encode(new Map(), [{ block: 3488582n, tx: 1n, amount: 99n, output: 2n }]);
  assert.equal(decodeScript(hex, 3).dataOutput, 2);
  assert.equal(decodeScript(hex, 3).kind, 'valid');
  assert.equal(decodeScript(hex, 2).dataOutput, 1);
  assert.deepEqual(decodeScript(hex, 2).errors, ['edict_output_out_of_range']);
  // A syntactically valid edict can target the synthetic carrier; decoding is
  // not proof that a real transaction allocates spendable tokens to a wallet.
  assert.deepEqual(decodeScript(hex, 3).edicts[0], { id: '3488582:1', amount: '99', output: '2' });
});

test('all example classifications and bundled decoder match the native codec', async () => {
  const page = await browser();
  assert.deepEqual(page.exampleScripts.map(({ id }) => id), ['mint', 'etch', 'malformed', 'ordinary']);
  assert.deepEqual(page.exampleScripts.map(({ hex, outputCount }) => page.decodeScript(hex, outputCount).kind), ['valid', 'valid', 'malformed', 'absent']);
  const retainedName = encode(new Map([[2n, [1n]], [4n, [encodeName('DEMO')]]])) + '4c';
  const scripts = [...page.exampleScripts, { hex: retainedName, outputCount: 3 }];
  for (const { hex, outputCount } of scripts) {
    const actual = page.decodeScript(hex, outputCount);
    const expected = decode(outputs(hex, outputCount));
    assert.equal(actual.kind, expected.kind);
    assert.equal(actual.dataOutput, expected.dataOutput);
    assert.deepEqual(actual.errors, expected.errors);
    assert.deepEqual(actual.ambiguity, expected.ambiguity);
    assert.deepEqual(actual.fields.map(({ tag, values }) => [tag, values]), [...expected.fields].map(([tag, values]) => [tag.toString(), values.map(String)]));
    assert.deepEqual(actual.edicts, expected.edicts.map(({ block, tx, amount, output }) => ({ id: `${block}:${tx}`, amount: String(amount), output: String(output) })));
  }
  assert.deepEqual(page.decodeScript(retainedName).ambiguity, ['malformed_push_recovery']);
});

test('browser hashes preserve byte views, chained updates, encodings and Buffer results', async () => {
  const { createHash } = await browser();
  const bytes = new Uint8Array([0xff, 0, 1, 0x80, 0xfe]);
  const view = new DataView(bytes.buffer, 1, 3);
  for (const algorithm of ['sha256', 'ripemd160']) {
    const expected = nodeHash(algorithm).update('ZRN1-ETCH', 'ascii').update(view).update('00ff', 'hex').digest();
    const actual = createHash(algorithm).update('ZRN1-ETCH', 'ascii').update(view).update('00ff', 'hex').digest();
    assert.equal(actual.constructor.isBuffer(actual), true);
    assert.equal(actual.toString('hex'), expected.toString('hex'));
    assert.equal(createHash(algorithm).update('é雪').digest('hex'), nodeHash(algorithm).update('é雪').digest('hex'));
    assert.equal(createHash(algorithm).update(bytes.subarray(1, 4)).digest('base64'), nodeHash(algorithm).update(bytes.subarray(1, 4)).digest('base64'));
    assert.equal(createHash(algorithm).digest('hex'), nodeHash(algorithm).digest('hex'));
    const finalized = createHash(algorithm);
    finalized.digest();
    assert.throws(() => finalized.update(bytes), /digest|final/i);
    assert.throws(() => finalized.digest(), /digest|final/i);
  }
  assert.throws(() => createHash('md5'), /unsupported.*algorithm/i);
  assert.throws(() => createHash('sha256').update([1, 2]), /data|buffer|array/i);
});

test('browser commitment hashes match native SHA-256 with exact u128 bytes', async () => {
  const page = await browser();
  for (const value of [encodeName('DEMO'), encodeName('TENYEARSNOOVERSHARING'), (1n << 128n) - 1n]) {
    assert.equal(page.commitmentHash(value).toString('hex'), commitmentHash(value).toString('hex'));
  }
});

test('browser ledger preserves allocations above 2^53 in a constructed transaction context', async () => {
  const page = await browser();
  const amount = 9007199254740993n;
  const hash = (value) => value.toString(16).padStart(64, '0');
  const name = encodeName('DEMO');
  const redeem = Buffer.concat([Buffer.from([32]), commitmentHash(name), Buffer.from([117, 33, 2]), Buffer.alloc(32, 3), Buffer.from([172])]);
  const commitment = nodeHash('ripemd160').update(nodeHash('sha256').update(redeem).digest()).digest('hex');
  const block = (height, tx = []) => ({ height, hash: hash(height), previousblockhash: hash(height - 1), tx });
  const commit = { txid: hash(101), vin: [{ coinbase: '00' }], vout: outputs(`a914${commitment}87`, 1) };
  const carrier = encode(new Map([[2n, [1n]], [4n, [name]], [12n, [amount]], [22n, [1n]]]), [
    { block: 0n, tx: 0n, amount: amount - 1n, output: 0n },
  ]);
  const etch = {
    txid: hash(107),
    vin: [{ txid: commit.txid, vout: 0, scriptSig: { hex: `004d4500${redeem.toString('hex')}` } }],
    vout: outputs(carrier, 3),
  };
  const native = new Ledger({ network: 'regtest', previousHash: hash(0) });
  const bundled = new page.Ledger({ network: 'regtest', previousHash: hash(0) });
  for (const ledger of [native, bundled]) {
    ledger.applyBlock(block(1, [commit]));
    for (let height = 2; height <= 6; height++) ledger.applyBlock(block(height));
    ledger.applyBlock(block(7, [etch]));
    assert.equal(ledger.balance(`${etch.txid}:0`, '7:0'), amount - 1n);
    assert.equal(ledger.balance(`${etch.txid}:1`, '7:0'), 1n);
    assert.equal(ledger.snapshot().assets[0].supply, amount.toString());
  }
  assert.deepEqual(bundled.snapshot(), native.snapshot());
});

test('historical browser replay matches every native asset and token-bearing output', async () => {
  const page = await browser();
  const actual = page.replaySample();
  const expected = nativeSnapshot();
  assert.deepEqual(actual, expected);
  assert.deepEqual(page.sampleInfo, { date: '2026-09-25', blocks: 52, transactions: 88, network: 'mainnet', complete: false });
  assert.equal(actual.coverage.mode, 'sample');
  assert.equal(actual.coverage.complete, false);
  assert.equal(actual.assets.length, 7);
  assert.equal(actual.outputs.length, 3);
  assert.equal(actual.assets.find(({ name }) => name === 'ZRUNES').supply, '1000000000000000000000');
  const glass = actual.assets.find(({ name }) => name === 'GLASSTESTONE');
  assert.deepEqual([glass.supply, glass.burned, glass.circulating], ['1000', '298', '702']);
  assert.doesNotThrow(() => JSON.stringify(actual));
  actual.assets[0].name = 'MUTATED';
  assert.deepEqual(page.replaySample(), expected, 'each replay is independent of prior returned data');
});
