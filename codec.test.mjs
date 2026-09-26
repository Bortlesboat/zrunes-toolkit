import assert from 'node:assert/strict';
import test from 'node:test';
import { commitmentHash, decode, decodeName, encode, encodeName, readPushes } from './codec.mjs';

const U128 = (1n << 128n) - 1n;
const U32 = (1n << 32n) - 1n;
const NAME = 18278n; // AAAA: the first allowed name in v1.
const fields = (...entries) => new Map(entries);
const etch = (...entries) => fields([2n, [1n]], [4n, [NAME]], ...entries);

// Independent fixture writer deliberately does not call encode().
function varint(value) {
  const result = [];
  do {
    const byte = Number(value & 127n);
    value >>= 7n;
    result.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(result);
}
const integers = (...values) => Buffer.concat(values.map(varint));
function script(payload) {
  const chunks = [Buffer.from([0x6a, 0x5e])];
  for (let i = 0; i < payload.length; i += 255) {
    const chunk = payload.subarray(i, i + 255);
    chunks.push(Buffer.from(chunk.length <= 75 ? [chunk.length] : [0x4c, chunk.length]), chunk);
  }
  return Buffer.concat(chunks).toString('hex');
}
const output = (hex, valueZat = 0) => ({ valueZat, scriptPubKey: { hex } });
const outputs = (hex, count = 2) => [output(hex), ...Array.from({ length: count - 1 }, () => output('51', 1))];
const message = (...values) => decode(outputs(script(integers(...values))));
function malformed(result, error) {
  assert.equal(result.kind, 'malformed');
  assert.ok(result.errors.includes(error), JSON.stringify(result.errors));
}

test('recognizes the immediate OP_14 marker only, including a bare empty carrier', () => {
  for (const hex of ['6a5d00', '6a015e', '516a5e', '', '6a']) {
    assert.deepEqual(decode(outputs(hex)), {
      kind: 'absent', fields: new Map(), edicts: [], dataOutput: null, errors: [], ambiguity: [],
    });
  }
  const result = decode([output('51', 3), output('6a5e')]);
  assert.equal(result.kind, 'valid');
  assert.equal(result.dataOutput, 1);
  assert.equal(result.fields.size, 0);
});

test('zero-value carrier, duplicate carriers and ordinary foreign data output', () => {
  for (const value of [1, 1n, '1']) malformed(decode(outputs('6a5e').map((out, i) => i ? out : { ...out, valueZat: value })), 'nonzero_data_output');
  for (const value of [0, 0n, '0']) assert.equal(decode([output('6a5e', value)]).kind, 'valid');
  const duplicate = decode([output(script(integers(24n, 5n, 1n))), output('6a5e')]);
  malformed(duplicate, 'multiple_zrunestones');
  assert.deepEqual(duplicate.fields.get(24n), [5n, 1n]);
  assert.ok(duplicate.ambiguity.includes('multiple_zrunestones'));
  assert.equal(decode([output('6a01ff'), output('6a5e')]).kind, 'valid');
});

test('strict RPC input validation does not silently coerce malformed hex or unsafe values', () => {
  for (const hex of ['6a5ez0', '6a5e0', 'zz', '6a 5e', '6a5e\n']) assert.throws(() => decode(outputs(hex)), /hex/);
  for (const value of [undefined, null, NaN, 0.1, Number.MAX_SAFE_INTEGER + 1, -1, '0.0', '0\n']) {
    assert.throws(() => decode([{ valueZat: value, scriptPubKey: { hex: '6a5e' } }]), /valueZat/);
  }
  assert.throws(() => decode(null), /outputs/);
  assert.throws(() => decode([{}]), /scriptPubKey/);
});

test('direct pushes, PUSHDATA1 and empty pushes concatenate; no minimal-push rule is invented', () => {
  // Separate canonical fixture: tag FLAGS and value zero across two pushes.
  const result = decode(outputs('6a5e0001024c010000'));
  assert.equal(result.kind, 'valid');
  assert.deepEqual(result.fields.get(2n), [0n]);
  assert.deepEqual(readPushes(Buffer.from('000202004c010100', 'hex')).map((part) => part.toString('hex')), ['', '0200', '01', '']);
  assert.deepEqual(readPushes(Buffer.from('6a5e020200', 'hex'), 2), [Buffer.from('0200', 'hex')]);
  assert.throws(() => readPushes(Buffer.from('6a5e', 'hex'), -1), /start/);
});

test('invalid opcodes and truncated pushes preserve fields from complete prefix pushes', () => {
  for (const tail of ['51', '4d0000', '4e00000000', '4c', '0301', '4c0301']) {
    const prefix = script(integers(24n, 3n, 7n));
    const result = decode(outputs(prefix + tail));
    assert.equal(result.kind, 'malformed', tail);
    assert.deepEqual(result.fields.get(24n), [3n, 7n], tail);
    assert.ok(result.ambiguity.includes('malformed_push_recovery'), tail);
    assert.throws(() => readPushes(Buffer.from(tail, 'hex')));
  }
  malformed(decode(outputs('6a5e51')), 'invalid_push_opcode');
});

test('published mainnet sample etch and mint bytes decode exactly', () => {
  // Universe explorer observations, 2026-09-25. Etch txid:
  // 0775ec7191db754382f1ff0adf563e9af65a4030eee66d9817771387f07db68b
  const hex = '6a5e1e020304b4f1b39701060108a14d0a120e808080f5ddb8ebe4b56c1088a401';
  const expected = fields([2n, [3n]], [4n, [317520052n]], [6n, [1n]], [8n, [9889n]], [10n, [18n]], [14n, [1000000000000000000000n]], [16n, [21000n]]);
  const result = decode(outputs(hex));
  assert.equal(result.kind, 'valid');
  assert.deepEqual(result.fields, expected);
  assert.equal(decodeName(result.fields.get(4n)[0]), 'ZRUNES');
  assert.equal(encode(expected), hex);
  assert.equal(commitmentHash(317520052n).toString('hex'), 'efb48e1c739078b6ef3dc2e92953d8ccf07bfaa66ef21fd55a3899437207a1f6');
  // Mint txid 581abf103a4a0f581ece8682d9b1a90b4e3c76325193f685155f7d05873d015c.
  const mint = decode(outputs('6a5e061881a6d50114', 3));
  assert.equal(mint.kind, 'valid');
  assert.deepEqual(mint.fields, fields([24n, [3494657n, 20n]]));
});

test('complete fields survive invalid following varints, including an etch name and mint', () => {
  const prefix = integers(2n, 1n, 4n, NAME, 24n, 9n, 2n);
  for (const [tail, error] of [[Buffer.from([0x80]), 'truncated_varint'], [Buffer.from([0x80, 0]), 'nonminimal_varint'], [Buffer.alloc(19, 0x80), 'varint_overflow']]) {
    const result = decode(outputs(script(Buffer.concat([prefix, tail]))));
    malformed(result, error);
    assert.deepEqual(result.fields, etch([24n, [9n, 2n]]));
    assert.deepEqual(result.ambiguity, []);
  }
});

test('incomplete NAME and MINT do not leave partial issuance values', () => {
  const partialName = decode(outputs(script(Buffer.from([2, 1, 4, 0x80]))));
  malformed(partialName, 'truncated_pair');
  assert.equal(partialName.fields.has(4n), false);
  assert.deepEqual(partialName.fields.get(2n), [1n]);
  for (const tail of [[24], [24, 1], [24, 1, 0x80]]) {
    const partialMint = decode(outputs(script(Buffer.from([22, 0, ...tail]))));
    malformed(partialMint, 'truncated_pair');
    assert.equal(partialMint.fields.has(24n), false);
    assert.deepEqual(partialMint.fields.get(22n), [0n]);
  }
});

test('varint shortest-form, u128 and reader-specific truncation rules', () => {
  assert.deepEqual(message(1n, U128).fields, new Map()); // unknown odd value accepts all u128.
  const tooLarge = Buffer.concat([Buffer.alloc(18, 0xff), Buffer.from([4])]);
  const nonminimal = Buffer.from([0x80, 0]);
  for (const [prefix, error] of [[[], 'truncated_varint'], [[2], 'truncated_pair'], [[24, 1], 'truncated_pair'], [[0, 1, 1, 1], 'truncated_edict']]) {
    malformed(decode(outputs(script(Buffer.from([...prefix, 0x80])))), error);
    malformed(decode(outputs(script(Buffer.concat([Buffer.from(prefix), tooLarge])))), 'varint_overflow');
    malformed(decode(outputs(script(Buffer.concat([Buffer.from(prefix), nonminimal])))), 'nonminimal_varint');
  }
  malformed(message(2n), 'truncated_pair');
  malformed(message(24n, 1n), 'truncated_pair');
  malformed(message(0n, 1n, 1n, 1n), 'truncated_edict');
  assert.equal(message(0n).kind, 'valid');
});

test('known scalar and MINT duplicates are malformed, preserving the first complete value', () => {
  for (const tag of [2n, 4n, 6n, 8n, 10n, 12n, 14n, 16n, 18n, 20n, 22n]) {
    const result = message(tag, 1n, tag, 2n);
    malformed(result, 'duplicate_tag');
    assert.deepEqual(result.fields.get(tag), [1n]);
    assert.ok(result.ambiguity.includes('duplicate_known_tag_recovery'));
  }
  const result = message(24n, 3n, 7n, 24n, 4n, 9n);
  malformed(result, 'duplicate_tag');
  assert.deepEqual(result.fields.get(24n), [3n, 7n]);
  assert.equal(message(24n, 3n, 7n).kind, 'valid');
});

test('unknown odd fields consume one value and may repeat; unknown even fields are malformed', () => {
  const odd = message(1n, 100n, 1n, 200n, 27n, 3n, 22n, 0n);
  assert.equal(odd.kind, 'valid');
  assert.deepEqual(odd.fields, fields([22n, [0n]]));
  const even = message(26n, 100n, 24n, 3n, 7n);
  malformed(even, 'unknown_even_tag');
  assert.deepEqual(even.fields.get(24n), [3n, 7n]);
});

test('flag and field dependencies distinguish terms fields from etching fields', () => {
  assert.equal(message(2n, 0n).kind, 'valid');
  malformed(message(2n, 4n), 'unknown_flags');
  malformed(message(2n, 2n, 14n, 1n, 16n, 1n), 'terms_without_etching');
  malformed(message(2n, 1n), 'etching_without_name');
  for (const [tag, value] of [[4n, NAME], [6n, 0n], [8n, 65n], [10n, 0n], [12n, 0n]]) malformed(message(tag, value), 'field_without_etching');
  for (const tag of [14n, 16n, 18n, 20n]) {
    const result = message(tag, 1n);
    malformed(result, 'field_without_terms');
    assert.ok(!result.errors.includes('field_without_etching'));
  }
});

test('name range, spacer positions, display values and scalar/index limits', () => {
  for (const value of [0n, NAME - 1n, U128]) malformed(message(2n, 1n, 4n, value), 'invalid_name');
  for (const value of [8n, 1n << 25n]) malformed(message(2n, 1n, 4n, NAME, 6n, value), 'invalid_spacers');
  assert.equal(message(2n, 1n, 4n, NAME, 6n, 7n, 10n, 18n).kind, 'valid');
  malformed(message(2n, 1n, 4n, NAME, 10n, 19n), 'invalid_divisibility');
  for (const value of [0xd800n, 0xdfffn, 0x110000n]) malformed(message(2n, 1n, 4n, NAME, 8n, value), 'invalid_symbol');
  for (const value of [0n, 0xd7ffn, 0xe000n, 0x10ffffn]) assert.equal(message(2n, 1n, 4n, NAME, 8n, value).kind, 'valid');
  for (const tag of [18n, 20n, 22n]) malformed(message(tag, U32 + 1n), 'index_overflow');
  for (const pair of [[U32 + 1n, 0n], [0n, U32 + 1n]]) malformed(message(24n, ...pair), 'index_overflow');
  assert.equal(message(24n, U32, U32, 22n, U32).kind, 'valid'); // nonexistent POINTER is a state-level burn.
});

test('terms require positive cap/amount, ordered explicit window and checked u128 maximum supply', () => {
  for (const tail of [[14n, 1n], [16n, 1n], [14n, 0n, 16n, 1n], [14n, 1n, 16n, 0n]]) malformed(message(2n, 3n, 4n, NAME, ...tail), 'invalid_terms');
  malformed(message(2n, 3n, 4n, NAME, 14n, 1n, 16n, 1n, 18n, 11n, 20n, 10n), 'invalid_height_window');
  malformed(message(2n, 3n, 4n, NAME, 14n, U128, 16n, 2n), 'supply_overflow');
  malformed(message(2n, 3n, 4n, NAME, 14n, U128, 16n, 1n, 12n, 1n), 'supply_overflow');
  assert.equal(message(2n, 3n, 4n, NAME, 14n, U128, 16n, 1n).kind, 'valid');
  assert.equal(message(2n, 1n, 4n, NAME, 12n, U128).kind, 'valid');
  assert.equal(message(2n, 3n, 4n, NAME, 14n, 1n, 16n, 1n, 20n, 0n).kind, 'valid');
});

test('edict deltas reconstruct strictly ascending ids, including tx reset on block change', () => {
  const result = message(0n, 10n, 7n, 9n, 1n, 0n, 3n, 0n, 0n, 2n, 1n, U128, 1n);
  assert.equal(result.kind, 'valid');
  assert.deepEqual(result.edicts, [
    { block: 10n, tx: 7n, amount: 9n, output: 1n },
    { block: 10n, tx: 10n, amount: 0n, output: 0n },
    { block: 12n, tx: 1n, amount: U128, output: 1n },
  ]);
  malformed(message(0n, 10n, 7n, 1n, 0n, 0n, 0n, 1n, 0n), 'edict_not_ascending');
  malformed(message(0n, 0n, 0n, 1n, 0n), 'edict_zero_without_etching');
  assert.equal(message(2n, 1n, 4n, NAME, 0n, 0n, 0n, 1n, 0n).kind, 'valid');
  assert.equal(message(0n, 0n, 1n, 1n, 0n).kind, 'valid');
});

test('edict decoded-id bounds precede ascent, zero-id and output checks; actual output bounds apply', () => {
  malformed(message(0n, U32 + 1n, 0n, 1n, U128), 'edict_id_overflow');
  malformed(message(0n, 1n, U32 + 1n, 1n, 0n), 'edict_id_overflow');
  malformed(message(0n, U32, 1n, 1n, 0n, 1n, 0n, 1n, 0n), 'edict_id_overflow');
  malformed(message(0n, 1n, U32, 1n, 0n, 0n, 1n, 1n, 0n), 'edict_id_overflow');
  assert.equal(message(0n, U32, U32, 1n, 1n).kind, 'valid');
  malformed(message(0n, 1n, 0n, 1n, 2n), 'edict_output_out_of_range');
  malformed(message(0n, 1n, 0n, 1n, U32 + 1n), 'edict_output_out_of_range');
  const result = message(0n, U32 + 1n, 0n, 1n, U128);
  assert.equal(result.errors[0], 'edict_id_overflow');
  assert.ok(!result.errors.includes('edict_output_out_of_range'));
});

test('at most 16 edicts; a partial 17th group remains a truncated edict', () => {
  const edicts = Array.from({ length: 16 }, (_, i) => [i ? 0n : 1n, 1n, 0n, 0n]).flat();
  assert.equal(message(0n, ...edicts).edicts.length, 16);
  malformed(message(0n, ...edicts, 0n, 1n, 0n, 0n), 'too_many_edicts');
  malformed(message(0n, ...edicts, 0n), 'truncated_edict');
});

test('name helpers enforce v1 lengths, letters, u128 and bijective base-26', () => {
  assert.equal(encodeName('AAAA'), NAME);
  assert.equal(encodeName('ZRUNES'), 317520052n);
  for (const name of ['AAAA', 'ZZZZ', 'AAAAA', 'ZRUNES', 'A'.repeat(26), 'Z'.repeat(26)]) assert.equal(decodeName(encodeName(name)), name);
  for (const name of ['', 'A', 'ZZZ', 'A'.repeat(27), 'aaaa', 'A•AAA', ' AAAA', 'AAA1', 'AAAA\n']) assert.throws(() => encodeName(name), /name/);
  for (const value of [-1n, 0n, NAME - 1n, U128, U128 + 1n, 18278]) assert.throws(() => decodeName(value));
  for (const value of [-1n, U128 + 1n, 18278]) assert.throws(() => commitmentHash(value));
  assert.equal(commitmentHash(NAME).length, 32);
});

test('encoding orders fields, omits explicit zero defaults and does not mutate caller data', () => {
  const input = fields([12n, [0n]], [10n, [0n]], [6n, [0n]], [4n, [NAME]], [2n, [1n]]);
  const original = structuredClone(input);
  assert.equal(encode(input), script(integers(2n, 1n, 4n, NAME)));
  assert.deepEqual(input, original);
  assert.equal(encode(new Map()), '6a5e');
  assert.equal(encode(fields([2n, [0n]])), '6a5e020200');
  // An explicit zero default must still have valid flag context before omission.
  assert.throws(() => encode(fields([12n, [0n]])), /field_without_etching/);
});

test('encoding accepts repeated unknown odd annotation values, validates fields and edicts', () => {
  assert.equal(encode(fields([1n, [100n, 200n]])), script(integers(1n, 100n, 1n, 200n)));
  const edicts = [{ block: 9n, tx: 3n, amount: U128, output: 1n }, { block: 9n, tx: 4n, amount: 0n, output: 0n }];
  assert.deepEqual(decode(outputs(encode(new Map(), edicts))).edicts, edicts);
  for (const bad of [new Map([[2, [0n]]]), fields([2n, [0]]), fields([2n, []]), fields([24n, [1n]]), fields([2n, [0n, 0n]]), fields([0n, []]), fields([26n, [1n]]), fields([1n, [-1n]]), fields([1n, [U128 + 1n]])]) assert.throws(() => encode(bad));
  assert.throws(() => encode(new Map(), [...edicts].reverse()), /edict_not_ascending/);
  assert.throws(() => encode(new Map(), [{ block: 1n, tx: 0n, amount: 0n, output: U32 + 1n }]), /edict_output_out_of_range/);
  assert.throws(() => encode(new Map(), [{ block: U32 + 1n, tx: 0n, amount: 0n, output: 0n }]), /edict_id_overflow/);
  assert.throws(() => encode(new Map(), [{ block: 0n, tx: 0n, amount: 0n, output: 0n }]), /edict_zero_without_etching/);
  assert.throws(() => encode(new Map(), Array.from({ length: 17 }, (_, i) => ({ block: 1n, tx: BigInt(i), amount: 0n, output: 0n }))), /too_many_edicts/);
});

test('79-byte relay cap is encoder-only; direct push ends at 75 bytes', () => {
  // Tag 1 takes one byte. Value 128 takes two, all other values below take one.
  for (const length of [75, 76, 79, 80]) {
    const pairs = (length - (length % 2 ? 3 : 0)) / 2;
    const values = [...Array(pairs).fill(0n), ...(length % 2 ? [128n] : [])];
    const raw = script(Buffer.concat(values.flatMap((value) => [varint(1n), varint(value)])));
    assert.equal(decode(outputs(raw)).kind, 'valid');
    if (length > 79) assert.throws(() => encode(fields([1n, values])), /relay_payload_limit/);
    else {
      const encoded = encode(fields([1n, values]));
      assert.equal(encoded, raw);
      assert.equal(Buffer.from(encoded, 'hex').length, length + (length <= 75 ? 3 : 4));
      assert.ok(encoded.startsWith(length <= 75 ? '6a5e4b' : '6a5e4c'));
    }
  }
});

test('push boundaries do not break varints and mined carriers can span several PUSHDATA1 chunks', () => {
  const split = decode(outputs('6a5e0218804c0101000102'));
  assert.equal(split.kind, 'valid');
  assert.deepEqual(split.fields.get(24n), [128n, 2n]);
  const payload = Buffer.concat([integers(...Array.from({ length: 300 }, () => [1n, 0n]).flat()), integers(24n, U32, U32)]);
  const result = decode(outputs(script(payload)));
  assert.equal(result.kind, 'valid');
  assert.deepEqual(result.fields.get(24n), [U32, U32]);
});

test('bounded deterministic round trips span values above IEEE safe integer range', () => {
  let state = 0x9876543210abcdefn;
  for (let i = 0; i < 100; i++) {
    state = (state * 6364136223846793005n + 1442695040888963407n) & U128;
    const input = etch([12n, [state]], [22n, [BigInt(i)]]);
    const result = decode(outputs(encode(input)));
    assert.equal(result.kind, 'valid');
    assert.deepEqual(result.fields, input);
  }
});
