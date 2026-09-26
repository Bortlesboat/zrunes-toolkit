import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replay, readArchive, writeCheckpoint, sync, withCheckpointLock } from './replay.mjs';

const h = (n) => n.toString(16).padStart(64, '0');
const genesis = '029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327';
const b = (height, hash = h(height), prev = height === 1 ? genesis : h(height - 1)) => ({ height, hash, previousblockhash: prev, tx: [] });
const archive = (blocks = []) => ({ schema: 'zrunes-block-archive-v1', network: 'regtest', mode: 'complete', startHeight: 1, previousHash: genesis, genesisHash: genesis, blocks });

test('checkpoint replay derives state again and detects malformed/truncated archives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zrunes-replay-'));
  try {
    const file = join(dir, 'checkpoint.json');
    const input = archive([b(1), b(2)]);
    writeCheckpoint(file, input);
    assert.deepEqual(replay(readArchive(file)).snapshot(), replay(input).snapshot());
    const good = readFileSync(file, 'utf8');
    assert.throws(() => writeCheckpoint(file, archive([b(2)])), /height|contiguous/);
    assert.equal(readFileSync(file, 'utf8'), good);
    writeFileSync(file, good.slice(0, -20));
    assert.throws(() => readArchive(file), /JSON/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('RPC sync resumes, removes a reorg branch and binds the network and genesis', async () => {
  const calls = [];
  let branch = [b(1), b(2), b(3)];
  const rpc = async (method, params) => {
    calls.push(method);
    if (method === 'getblockchaininfo') return { chain: 'test', blocks: branch.length };
    if (method === 'getblockhash') return params[0] === 0 ? genesis : branch[params[0] - 1].hash;
    if (method === 'getblock') return branch.find((block) => block.hash === params[0]);
    throw new Error(`unexpected ${method}`);
  };
  const first = await sync(rpc, { network: 'regtest', to: 2 });
  assert.equal(first.blocks.length, 2);
  branch = [b(1), b(2, h(22)), b(3, h(33), h(22))];
  const next = await sync(rpc, { network: 'regtest', to: 3, archive: first });
  assert.equal(next.blocks[1].hash, h(22));
  assert.equal(replay(next).tip.hash, h(33));
  assert.equal(first.blocks[1].hash, h(2), 'caller archive is not mutated');
  await assert.rejects(sync(rpc, { network: 'mainnet', to: 3 }), /network/);
  await assert.rejects(sync(rpc, { network: 'regtest', to: 3, archive: { ...first, genesisHash: h(99) } }), /genesis/);
  assert.ok(calls.includes('getblock'));
});

test('sync rejects a changing target and never delivers a falsely stable checkpoint', async () => {
  let targetReads = 0;
  const rpc = async (method, params) => {
    if (method === 'getblockchaininfo') return { chain: 'regtest', blocks: 1 };
    if (method === 'getblockhash') {
      if (params[0] === 0) return genesis;
      return ++targetReads === 1 ? h(1) : h(999);
    }
    if (method === 'getblock') return b(1);
    throw new Error(method);
  };
  await assert.rejects(sync(rpc, { network: 'regtest', to: 1 }), /changed|reorg/);
});

test('the generic test label never admits a foreign genesis as regtest', async () => {
  const rpc = async (method) => method === 'getblockchaininfo' ? { chain: 'test', blocks: 1 } : h(999);
  await assert.rejects(sync(rpc, { network: 'regtest', to: 1 }), /network/);
});

test('a second writer cannot replace a checkpoint; failure releases only its own lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zrunes-lock-'));
  const file = join(dir, 'archive.json');
  try {
    await withCheckpointLock(file, async () => {
      await assert.rejects(withCheckpointLock(file, async () => assert.fail('second writer entered')), /locked/);
    });
    await assert.rejects(withCheckpointLock(file, async () => { throw new Error('test failure'); }), /test failure/);
    await withCheckpointLock(file, async () => writeCheckpoint(file, archive([b(1)])));
    assert.equal(readArchive(file).blocks.length, 1);
  } finally { rmSync(dir, { recursive: true }); }
});
