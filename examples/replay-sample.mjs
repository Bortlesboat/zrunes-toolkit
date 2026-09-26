import { fileURLToPath } from 'node:url';
import { readArchive, replay } from '../index.mjs';

const archive = readArchive(fileURLToPath(new URL('../fixtures/mainnet/sample-bundle.json', import.meta.url)));
const snapshot = replay(archive).snapshot();
console.log(JSON.stringify({
  coverage: snapshot.coverage,
  assets: snapshot.assets.map(({ id, name, supply, burned }) => ({ id, name, supply, burned })),
  notice: 'Historical sample only. This is not a current balance or complete mainnet scan.',
}, null, 2));
