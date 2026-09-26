# Interactive demo

[Open the demo](https://bortlesboat.github.io/zrunes-toolkit/).

Decode a transparent output script, inspect fields and allocations, and replay
the included September 25, 2026 historical sample. All interactive work runs in
the browser. The page makes no RPC requests, connects no wallet, and broadcasts
no transactions. Input is neither stored nor sent to an application server.
The host still receives ordinary page and asset requests.

## Develop

Use Node.js 22 or newer. From the repository root:

```sh
npm ci --prefix website
npm test --prefix website
npm run build --prefix website
python -m http.server 4179 --bind 127.0.0.1 --directory website/dist
```

Open `http://127.0.0.1:4179`. The build produces only static files in
`website/dist/`. Asset paths work under the GitHub Pages project subdirectory.
The Pages workflow tests and builds pull requests, and deploys successful builds
from `main`. GitHub Pages must use **GitHub Actions** as its source.

## Boundaries

The demo imports the original `codec.mjs` and `ledger.mjs`. `buffer` and
`@noble/hashes` adapt the Node APIs these two modules require; they are isolated
to this site. This is not a supported browser SDK entry point, and it does not
bundle RPC, persistence, wallet signing, or settlement code. The root package
and its installation contract remain unchanged.

The decoder places the pasted script in the last output and uses zero-value
`OP_TRUE` placeholders for earlier outputs. Output count affects validation.
Parsing alone does not establish ownership, eligibility, or valid issuance.
The ledger sample is incomplete and historical; amounts are exact raw units,
not current balances or a complete list of tokens. Unknown history is not a
zero balance. See the [integration boundaries](../docs/integration.md).

Tests compare bundled browser behavior with the native codec and ledger,
including quantities above JavaScript's safe integer limit, output allocation,
commitment hashing, malformed input, and every recorded sample asset and output.

## Attribution

Original site code is covered by the repository's [MIT license](../LICENSE).
Protocol and historical evidence attribution is in [NOTICE.md](../NOTICE.md).
The build retains dependency license comments and includes the complete notices
for the toolkit, bundled dependencies, protocol, evidence, and fonts in
`licenses.txt`. Self-hosted fonts use the SIL
Open Font License; their full notices are included in `fonts/` and the build:

- [Barlow Semi Condensed](https://github.com/google/fonts/tree/main/ofl/barlowsemicondensed)
  — `fonts/barlow-OFL.txt`.
- [IBM Plex Sans](https://github.com/google/fonts/tree/main/ofl/ibmplexsans)
  — `fonts/ibm-plex-OFL.txt`.

No fonts, scripts, analytics, or other runtime resources load from third-party
origins.
