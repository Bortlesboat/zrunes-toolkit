import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Ledger, ACTIVATION } from './ledger.mjs';

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const SCHEMA = 'zrunes-block-archive-v1';
const REGTEST_GENESIS = '029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327';

export function readArchive(file) {
  if (statSync(file).size > MAX_ARCHIVE_BYTES) throw new Error('archive exceeds 128 MiB research limit');
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

export function replay(archive) {
  if (archive.schema !== undefined && archive.schema !== SCHEMA) throw new Error('unknown archive schema');
  if (!Array.isArray(archive.blocks) || !archive.blocks.length && !archive.previousHash) throw new Error('archive requires blocks and anchor');
  if (!['complete', 'sample'].includes(archive.mode)) throw new Error('archive must declare complete or sample coverage');
  const ledger = new Ledger({ network: archive.network, mode: archive.mode,
    startHeight: archive.startHeight ?? archive.blocks[0]?.height,
    previousHash: archive.previousHash ?? archive.blocks[0]?.previousblockhash });
  for (const block of archive.blocks) ledger.applyBlock(block);
  return ledger;
}

export function writeCheckpoint(file, archive) {
  replay(archive); // Never replace a valid checkpoint with an invalid branch.
  const text = `${JSON.stringify(archive)}\n`;
  if (Buffer.byteLength(text) > MAX_ARCHIVE_BYTES) throw new Error('archive exceeds 128 MiB research limit');
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export async function withCheckpointLock(file, operation) {
  const lock = `${file}.lock`;
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('checkpoint locked by another run; check ownership before removing a stale lock');
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await operation();
  } finally { closeSync(fd); unlinkSync(lock); }
}

// Only read-only node methods are used. The endpoint is an explicit trust boundary.
export function rpcClient(endpoint) {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('RPC requires HTTP(S), without credentials in the URL');
  return async (method, params = []) => {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}: ${method}`);
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 32 * 1024 * 1024) throw new Error('RPC response exceeds 32 MiB limit');
      chunks.push(chunk);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (result.error) throw new Error(`RPC ${method} failed: ${String(result.error.message).slice(0, 300)}`);
    if (result.result === undefined) throw new Error(`RPC ${method} lacks result`);
    return result.result;
  };
}

const blockHash = (response) => typeof response === 'string' ? response : response.hash;

export async function sync(rpc, options) {
  if (!(options.network in ACTIVATION)) throw new Error('unsupported network');
  const info = await rpc('getblockchaininfo', []);
  const genesisHash = blockHash(await rpc('getblockhash', [0]));
  // Zebra uses BIP70's "test" label for both testnet and regtest.
  // Disambiguate with the observed, pinned regtest genesis, not a loose alias.
  let remoteNetwork = { main: 'mainnet', test: 'testnet', regtest: 'regtest' }[info.chain] ?? info.chain;
  if (['test', 'testnet', 'regtest'].includes(info.chain) && genesisHash === REGTEST_GENESIS) remoteNetwork = 'regtest';
  if (remoteNetwork !== options.network || (options.network === 'regtest' && genesisHash !== REGTEST_GENESIS)) throw new Error('RPC network or genesis mismatch');
  const to = options.to ?? info.blocks;
  if (!Number.isSafeInteger(to) || to < 1 || to > info.blocks) throw new Error('invalid target height');
  let archive;
  if (options.archive) {
    archive = structuredClone(options.archive);
    if (archive.mode !== 'complete' || archive.network !== options.network) throw new Error('resume network or coverage mismatch');
    if (archive.genesisHash !== genesisHash) throw new Error('RPC genesis mismatch');
    replay(archive);
    if (options.from !== undefined && options.from !== archive.startHeight) throw new Error('resume start height mismatch');
  } else {
    const from = options.from ?? ACTIVATION[options.network];
    if (!Number.isSafeInteger(from) || from < 1 || from > to || from > ACTIVATION[options.network]) throw new Error('complete scan must start at or before activation');
    archive = { schema: SCHEMA, network: options.network, mode: 'complete', startHeight: from,
      genesisHash, previousHash: blockHash(await rpc('getblockhash', [from - 1])), blocks: [] };
  }
  if (to < archive.startHeight) throw new Error('target precedes archive start');
  // Remove orphaned blocks, then derive all balances again from the surviving data.
  while (archive.blocks.length) {
    const last = archive.blocks.at(-1);
    if (last.height <= to && blockHash(await rpc('getblockhash', [last.height])) === last.hash) break;
    archive.blocks.pop();
  }
  if (blockHash(await rpc('getblockhash', [archive.startHeight - 1])) !== archive.previousHash) throw new Error('reorganization crossed the archive anchor; start a new archive');
  const ledger = replay(archive);
  for (let height = ledger.tip.height + 1; height <= to; height++) {
    const expectedHash = blockHash(await rpc('getblockhash', [height]));
    const decoded = await rpc('getblock', [expectedHash, 2]);
    if (decoded.hash !== expectedHash || decoded.height !== height || !Array.isArray(decoded.tx)) throw new Error('RPC block identity mismatch');
    const block = { height, hash: expectedHash, previousblockhash: decoded.previousblockhash, tx: decoded.tx };
    // Commitments may predate protocol activation. Fetch their complete prevout
    // context from the same trusted node, and retain it for offline reproduction.
    for (const tx of block.tx) {
      const first = tx.vin?.[0];
      if (!first?.txid || ledger.commitments.has(`${first.txid}:${first.vout}`) || !tx.vout?.some((out) => out.scriptPubKey?.hex.startsWith('6a5e'))) continue;
      const previous = await rpc('getrawtransaction', [first.txid, 1]);
      if (!Number.isSafeInteger(previous.height) || previous.height < 0 || previous.txid !== first.txid || !previous.vout?.[first.vout]) throw new Error('RPC commitment context incomplete');
      block.commitmentPrevouts ??= [];
      block.commitmentPrevouts.push({ txid: first.txid, vout: first.vout, height: previous.height, scriptPubKey: previous.vout[first.vout].scriptPubKey });
    }
    ledger.applyBlock(block);
    archive.blocks.push(block);
  }
  if (blockHash(await rpc('getblockhash', [to])) !== ledger.tip.hash) throw new Error('chain changed during sync; checkpoint not replaced');
  return archive;
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === 'replay' && rest.length === 1) {
    console.log(JSON.stringify(replay(readArchive(rest[0])).snapshot(), null, 2));
    return;
  }
  if (command !== 'sync' || rest.length % 2) throw new Error('Usage: node replay.mjs replay ARCHIVE.json | sync --rpc URL --network regtest|testnet|mainnet --state FILE [--from HEIGHT] [--to HEIGHT]');
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!['--rpc', '--network', '--state', '--from', '--to'].includes(key) || key in flags) throw new Error('unknown or duplicate option');
    flags[key] = rest[i + 1];
  }
  if (!flags['--state'] || !flags['--rpc'] || !flags['--network']) throw new Error('sync requires --state, --rpc and --network');
  const file = resolve(flags['--state']);
  const archive = await withCheckpointLock(file, async () => {
    const result = await sync(rpcClient(flags['--rpc']), {
      network: flags['--network'], from: flags['--from'] === undefined ? undefined : Number(flags['--from']),
      to: flags['--to'] === undefined ? undefined : Number(flags['--to']),
      archive: existsSync(file) ? readArchive(file) : undefined,
    });
    writeCheckpoint(file, result);
    return result;
  });
  console.log(JSON.stringify(replay(archive).snapshot(), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
