import { decode, decodeName, encode, encodeName } from '../codec.mjs';
import { Ledger } from '../ledger.mjs';
import sample from '../fixtures/mainnet/sample-bundle.json' with { type: 'json' };

const labels = new Map([
  [2n, 'Flags'], [4n, 'Name'], [6n, 'Spacers'], [8n, 'Symbol'],
  [10n, 'Divisibility'], [12n, 'Premine'], [14n, 'Mint amount'],
  [16n, 'Mint cap'], [18n, 'Start height'], [20n, 'End height'],
  [22n, 'Pointer'], [24n, 'Mint'],
]);

/**
 * Inspect one script in synthetic transaction context: every output has zero
 * zatoshis, the supplied script is last, and all preceding scripts are OP_TRUE.
 * This checks output-index bounds; it proves no ownership, spendability of an
 * actual output, mint eligibility, commitment maturity, or ledger allocation.
 */
export function decodeScript(scriptHex, outputCount = 3) {
  if (typeof scriptHex !== 'string') throw new TypeError('Script must be hexadecimal text.');
  const hex = scriptHex.replace(/\s/g, '').toLowerCase();
  if (!hex.length || hex.length > 2048 || !/^(?:[0-9a-f]{2})+$/.test(hex)) {
    throw new RangeError('Script must contain 1–1024 bytes of even-length hexadecimal text.');
  }
  if (!Number.isSafeInteger(outputCount) || outputCount < 1 || outputCount > 32) {
    throw new RangeError('Output count must be a whole number from 1 to 32.');
  }
  const outputs = Array.from({ length: outputCount }, (_, index) => ({
    valueZat: 0,
    scriptPubKey: { hex: index === outputCount - 1 ? hex : '51' },
  }));
  const decoded = decode(outputs);
  let name = null;
  if (decoded.fields.has(4n)) {
    try { name = decodeName(decoded.fields.get(4n)[0]); }
    catch { /* The codec already reports invalid names in its diagnostics. */ }
  }
  return {
    kind: decoded.kind,
    dataOutput: decoded.dataOutput,
    fields: [...decoded.fields].map(([tag, values]) => ({ tag: String(tag), label: labels.get(tag), values: values.map(String) })),
    edicts: decoded.edicts.map(({ block, tx, amount, output }) => ({ id: `${block}:${tx}`, amount: String(amount), output: String(output) })),
    errors: decoded.errors,
    ambiguity: decoded.ambiguity,
    bytes: hex.length / 2,
    name,
  };
}

// These small constructed scripts demonstrate parsing, not valid issuance.
export const exampleScripts = [
  { id: 'mint', label: 'Mint fields', hex: encode(new Map([[24n, [3488582n, 1n]]])), outputCount: 3 },
  {
    id: 'etch', label: 'Etching fields',
    hex: encode(new Map([[2n, [1n]], [4n, [encodeName('DEMO')]], [12n, [9007199254740993n]]]), [
      { block: 0n, tx: 0n, amount: 9007199254740993n, output: 0n },
    ]),
    outputCount: 3,
  },
  { id: 'malformed', label: 'Malformed carrier', hex: '6a5e021a01', outputCount: 3 },
  { id: 'ordinary', label: 'Ordinary script', hex: '51', outputCount: 3 },
];

export const sampleInfo = Object.freeze({
  date: '2026-09-25',
  blocks: sample.blocks.length,
  transactions: sample.blocks.reduce((count, block) => count + block.tx.length, 0),
  network: sample.network,
  complete: false,
});

/** Replay the captured, incomplete historical fixture with the original ledger. */
export function replaySample() {
  const ledger = new Ledger(sample);
  for (const block of sample.blocks) ledger.applyBlock(block);
  return ledger.snapshot();
}
