import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { Buffer } from 'buffer';

/** The synchronous createHash subset used by the unmodified codec and ledger. */
export function createHash(algorithm) {
  const hash = algorithm === 'sha256' ? sha256.create()
    : algorithm === 'ripemd160' ? ripemd160.create() : null;
  if (!hash) throw new Error(`Unsupported hash algorithm: ${algorithm}`);
  let finalized = false;
  const assertOpen = () => {
    if (finalized) throw new Error('Digest already finalized');
  };
  return {
    update(data, encoding) {
      assertOpen();
      let bytes;
      if (typeof data === 'string') bytes = Buffer.from(data, encoding);
      else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else throw new TypeError('Hash data must be a string, Buffer, typed array, or DataView');
      hash.update(bytes);
      return this;
    },
    digest(encoding) {
      assertOpen();
      finalized = true;
      const bytes = Buffer.from(hash.digest());
      return encoding === undefined ? bytes : bytes.toString(encoding);
    },
  };
}
