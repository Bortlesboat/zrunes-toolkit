/**
 * Independent implementation adapted from the published ZRunes v1 specification.
 * Source: Universe (bitcoinuniverseio), copyright 2026, documentation CC BY 4.0:
 * https://creativecommons.org/licenses/by/4.0/
 * https://github.com/bitcoinuniverseio/docs-zerdinals-and-zrunes/blob/de03cd1850cace694320ba3cc44789c2036daa7a/src/content/docs/protocols/zrunes-v1.md
 * This is newly written JavaScript, not the unavailable reference implementation.
 * Its diagnostic names and malformed recovery choices are not reference vectors.
 *
 * Recovery: retain first complete known fields; continue across semantic errors
 * while framing is intact; stop on unreadable varints; read only complete pushes.
 * The public document does not settle recovery from duplicate fields, multiple
 * carriers or broken push framing. `ambiguity` reports these cases; a state
 * engine must refuse an ambiguous result rather than guess its issuance effects.
 * Multiple carriers retain the first carrier only for inspection. All duplicate
 * known tags are conservatively ambiguous. Broken pushes are ambiguous when a
 * fully parsed NAME or MINT survives. Private DECISIONS.md/vectors are needed to
 * establish parity, including diagnostic precedence outside the published rules.
 */
import { createHash } from 'node:crypto';

const U128_MAX = (1n << 128n) - 1n;
const U32_MAX = (1n << 32n) - 1n;
const KNOWN = new Set([2n, 4n, 6n, 8n, 10n, 12n, 14n, 16n, 18n, 20n, 22n, 24n]);
const ZERO_DEFAULTS = new Set([6n, 10n, 12n]);
const first = (fields, tag) => fields.get(tag)?.[0];

function unsigned(value, label = 'integer') {
  if (typeof value !== 'bigint' || value < 0n || value > U128_MAX) {
    throw new RangeError(`${label} must be a u128 BigInt`);
  }
  return value;
}

function scanPushes(bytes, start) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array');
  if (!Number.isSafeInteger(start) || start < 0 || start > bytes.length) throw new RangeError('invalid start offset');
  const chunks = [];
  for (let i = start; i < bytes.length;) {
    const opcode = bytes[i++];
    let length;
    if (opcode <= 75) length = opcode;
    else if (opcode === 0x4c) {
      if (i === bytes.length) return { chunks, error: 'truncated_push' };
      length = bytes[i++];
    } else return { chunks, error: 'invalid_push_opcode' };
    if (length > bytes.length - i) return { chunks, error: 'truncated_push' };
    chunks.push(Buffer.from(bytes.subarray(i, i + length)));
    i += length;
  }
  return { chunks, error: null };
}

/** Read ordinary script data pushes (including OP_0); return Buffer[]. */
export function readPushes(bytes, start = 0) {
  const { chunks, error } = scanPushes(bytes, start);
  if (error) throw new Error(error);
  return chunks;
}

/** Encode a normalized 4–26 letter A–Z name; separators are display-only. */
export function encodeName(name) {
  if (typeof name !== 'string' || !/^[A-Z]{4,26}$/.test(name)) throw new RangeError('invalid name');
  let value = -1n;
  for (const letter of name) value = (value + 1n) * 26n + BigInt(letter.charCodeAt(0) - 65);
  return unsigned(value, 'name');
}

/** Decode a v1 name, rejecting the reserved short names and names beyond 26 letters. */
export function decodeName(value) {
  let remaining = unsigned(value, 'name') + 1n;
  let name = '';
  while (remaining) {
    remaining--;
    name = String.fromCharCode(65 + Number(remaining % 26n)) + name;
    remaining /= 26n;
  }
  if (name.length < 4 || name.length > 26) throw new RangeError('invalid name length');
  return name;
}

/** Raw 32-byte SHA-256 digest; commitment validity/maturity is a ledger concern. */
export function commitmentHash(nameValue) {
  let value = unsigned(nameValue, 'name');
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number(value & 255n);
    value >>= 8n;
  }
  return createHash('sha256').update('ZRN1-ETCH', 'ascii').update(bytes).digest();
}

class ParseError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function readVarint(reader, truncated) {
  let value = 0n;
  for (let length = 0; length < 19; length++) {
    if (reader.position === reader.bytes.length) throw new ParseError(truncated);
    const byte = reader.bytes[reader.position++];
    // The nineteenth group contains only bits 126 and 127; no continuation.
    if (length === 18 && (byte & 0xfc)) throw new ParseError('varint_overflow');
    value |= BigInt(byte & 127) << BigInt(length * 7);
    if (!(byte & 128)) {
      if (length && byte === 0) throw new ParseError('nonminimal_varint');
      return value;
    }
  }
  throw new ParseError('varint_overflow');
}

function validateFields(fields) {
  const errors = [];
  const flags = first(fields, 2n) ?? 0n;
  const etching = Boolean(flags & 1n);
  const terms = Boolean(flags & 2n);
  if (flags & ~3n) errors.push('unknown_flags');
  if (terms && !etching) errors.push('terms_without_etching');
  if (etching && !fields.has(4n)) errors.push('etching_without_name');
  if (!etching && [4n, 6n, 8n, 10n, 12n].some((tag) => fields.has(tag))) errors.push('field_without_etching');
  if (!terms && [14n, 16n, 18n, 20n].some((tag) => fields.has(tag))) errors.push('field_without_terms');

  let name;
  if (fields.has(4n)) {
    try { name = decodeName(first(fields, 4n)); }
    catch { errors.push('invalid_name'); }
  }
  const spacers = first(fields, 6n);
  if (spacers !== undefined && (spacers >= (1n << 25n) || (name && spacers >= (1n << BigInt(name.length - 1))))) errors.push('invalid_spacers');
  const symbol = first(fields, 8n);
  if (symbol !== undefined && (symbol > 0x10ffffn || (symbol >= 0xd800n && symbol <= 0xdfffn))) errors.push('invalid_symbol');
  if (first(fields, 10n) > 18n) errors.push('invalid_divisibility');
  if ([18n, 20n, 22n, 24n].some((tag) => fields.get(tag)?.some((value) => value > U32_MAX))) errors.push('index_overflow');

  if (terms) {
    const amount = first(fields, 14n);
    const cap = first(fields, 16n);
    if (!amount || !cap) errors.push('invalid_terms');
    if (fields.has(18n) && fields.has(20n) && first(fields, 20n) < first(fields, 18n)) errors.push('invalid_height_window');
    if (amount !== undefined && cap !== undefined && (first(fields, 12n) ?? 0n) + amount * cap > U128_MAX) errors.push('supply_overflow');
  }
  return errors;
}

function edictError(edict, previous, etching, outputCount) {
  // Ordering is normative: decoded-id bound, ascent, etching alias, output.
  if (edict.block > U32_MAX || edict.tx > U32_MAX) return 'edict_id_overflow';
  if (previous && (edict.block < previous.block || (edict.block === previous.block && edict.tx <= previous.tx))) return 'edict_not_ascending';
  if (edict.block === 0n && edict.tx === 0n && !etching) return 'edict_zero_without_etching';
  if (edict.output > U32_MAX || (outputCount !== undefined && edict.output >= BigInt(outputCount))) return 'edict_output_out_of_range';
  return null;
}

function parsePayload(payload, outputCount, result) {
  const reader = { bytes: payload, position: 0 };
  try {
    while (reader.position < payload.length) {
      const tag = readVarint(reader, 'truncated_varint');
      if (tag === 0n) {
        let previous;
        while (reader.position < payload.length) {
          const delta = readVarint(reader, 'truncated_edict');
          const txField = readVarint(reader, 'truncated_edict');
          const amount = readVarint(reader, 'truncated_edict');
          const output = readVarint(reader, 'truncated_edict');
          if (result.edicts.length === 16) throw new ParseError('too_many_edicts');
          const edict = {
            block: (previous?.block ?? 0n) + delta,
            tx: delta ? txField : (previous?.tx ?? 0n) + txField,
            amount, output,
          };
          const error = edictError(edict, previous, Boolean((first(result.fields, 2n) ?? 0n) & 1n), outputCount);
          if (error) throw new ParseError(error);
          result.edicts.push(edict);
          previous = edict;
        }
        break;
      }
      const duplicate = KNOWN.has(tag) && result.fields.has(tag);
      if (duplicate) {
        result.errors.push('duplicate_tag');
        result.ambiguity.push('duplicate_known_tag_recovery');
      }
      if (!KNOWN.has(tag) && tag % 2n === 0n) result.errors.push('unknown_even_tag');
      const values = [readVarint(reader, 'truncated_pair')];
      if (tag === 24n) values.push(readVarint(reader, 'truncated_pair'));
      if (KNOWN.has(tag) && !duplicate) result.fields.set(tag, values);
    }
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    result.errors.push(error.code);
  }
  result.errors.push(...validateFields(result.fields));
}

function outputScript(output) {
  const hex = output?.scriptPubKey?.hex;
  if (typeof hex !== 'string') throw new TypeError('output requires scriptPubKey.hex');
  if (!/^(?:[a-fA-F0-9]{2})*$/.test(hex)) throw new TypeError('invalid scriptPubKey hex');
  return Buffer.from(hex, 'hex');
}

function outputValue(output) {
  const value = output.valueZat;
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw new TypeError('valueZat must be an exact nonnegative integer');
}

/**
 * Decode RPC-shaped transparent outputs. Invalid RPC input throws; malformed
 * protocol bytes return `kind: 'malformed'` with retained complete fields.
 * Output indexes are array positions, not untrusted RPC `n` labels. Caller must
 * verify transaction and block integrity. Nonstandard oversized carriers decode.
 */
export function decode(outputs) {
  if (!Array.isArray(outputs)) throw new TypeError('outputs must be an array');
  const result = { kind: 'absent', fields: new Map(), edicts: [], dataOutput: null, errors: [], ambiguity: [] };
  const carriers = [];
  outputs.forEach((output, index) => {
    const bytes = outputScript(output);
    const value = outputValue(output);
    if (bytes[0] === 0x6a && bytes[1] === 0x5e) carriers.push({ index, bytes, value });
  });
  if (!carriers.length) return result;
  const carrier = carriers[0];
  result.dataOutput = carrier.index;
  if (carriers.length > 1) {
    result.errors.push('multiple_zrunestones');
    result.ambiguity.push('multiple_zrunestones');
  }
  if (carriers.some(({ value }) => value !== 0n)) result.errors.push('nonzero_data_output');
  const { chunks, error } = scanPushes(carrier.bytes, 2);
  if (error) result.errors.push(error);
  parsePayload(Buffer.concat(chunks), outputs.length, result);
  if (error && (result.fields.has(4n) || result.fields.has(24n))) result.ambiguity.push('malformed_push_recovery');
  result.errors = [...new Set(result.errors)];
  result.ambiguity = [...new Set(result.ambiguity)];
  result.kind = result.errors.length ? 'malformed' : 'valid';
  return result;
}

function writeVarint(value) {
  const bytes = [];
  do {
    const low = Number(value & 127n);
    value >>= 7n;
    bytes.push(low | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}

/**
 * Canonical relay-sized carrier. Known tags have one value (MINT has two);
 * unknown odd tags may have several values, emitted as repeated annotations.
 * Edicts must already be strictly sorted. This signature has no output count:
 * use decode(actualOutputs) before signing to verify each edict output exists.
 */
export function encode(fields, edicts = []) {
  if (!(fields instanceof Map)) throw new TypeError('fields must be a Map');
  if (!Array.isArray(edicts)) throw new TypeError('edicts must be an array');
  for (const [tag, values] of fields) {
    unsigned(tag, 'tag');
    if (tag === 0n) throw new RangeError('BODY belongs in edicts');
    if (!KNOWN.has(tag) && tag % 2n === 0n) throw new RangeError('unknown_even_tag');
    if (!Array.isArray(values) || values.length === 0 || (KNOWN.has(tag) && values.length !== (tag === 24n ? 2 : 1))) throw new RangeError('invalid field value count');
    for (const value of values) unsigned(value, 'field value');
  }
  const errors = validateFields(fields);
  if (errors.length) throw new RangeError(errors.join(', '));
  if (edicts.length > 16) throw new RangeError('too_many_edicts');
  const chunks = [];
  for (const [tag, values] of [...fields].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (ZERO_DEFAULTS.has(tag) && values[0] === 0n) continue;
    if (KNOWN.has(tag)) chunks.push(writeVarint(tag), ...values.map(writeVarint));
    else for (const value of values) chunks.push(writeVarint(tag), writeVarint(value));
  }
  let previous;
  if (edicts.length) chunks.push(writeVarint(0n));
  for (const edict of edicts) {
    for (const key of ['block', 'tx', 'amount', 'output']) unsigned(edict?.[key], `edict ${key}`);
    const error = edictError(edict, previous, Boolean((first(fields, 2n) ?? 0n) & 1n));
    if (error) throw new RangeError(error);
    const delta = edict.block - (previous?.block ?? 0n);
    chunks.push(...[delta, delta ? edict.tx : edict.tx - (previous?.tx ?? 0n), edict.amount, edict.output].map(writeVarint));
    previous = edict;
  }
  const payload = Buffer.concat(chunks);
  if (payload.length > 79) throw new RangeError('relay_payload_limit');
  const header = payload.length === 0 ? [0x6a, 0x5e] : payload.length <= 75 ? [0x6a, 0x5e, payload.length] : [0x6a, 0x5e, 0x4c, payload.length];
  const encoded = Buffer.concat([Buffer.from(header), payload]);
  if (encoded.length > 83) throw new RangeError('relay_script_limit');
  return encoded.toString('hex');
}
