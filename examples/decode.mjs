import { decode, encode } from '../index.mjs';

// MINT tag 24 refers to a token by its etching block and transaction index.
// This only decodes an instruction; it does not prove a mint is eligible.
const script = encode(new Map([[24n, [7n, 0n]]]));
const message = decode([{ n: 0, valueZat: '0', scriptPubKey: { hex: script } }]);
console.log(JSON.stringify({
  script,
  kind: message.kind,
  mint: message.fields.get(24n)?.map(String),
  errors: message.errors,
  ambiguity: message.ambiguity,
}, null, 2));
