# (p)IMD site, production build (no bundler, no dependencies)

Hash routing, data through `api.js`.

| File | What it is |
|---|---|
| `index.html` | the site, hash routing |
| `config.js` | the only file to edit: `ADAPTER`, `CONTRACT`, `DEPLOY_BLOCK`, `CHAIN_ID`, `RPCS` |
| `abi.js` | ABIs of PimdMarkets, BoundaryOracle, PimdRegistry, BoundaryProofVerifier |
| `api.js` | data layer: `demo` adapter (fake book/portfolio/leaderboard) and `chain` adapter (place/placeWithProofs, cancel, split/merge, claim/claimWithProofs/claimAll, deposit/withdraw; oracle propose/dispute/finalize/withdrawCredit; book from bestBid/bestAsk lists; portfolio and leaderboard from events) |
| `wallet.js` | wallet module, one interface for the whole site (`connect`, `address`, `chainId`, `sendTx`, `signTypedData`, `list`, …). Login: browser wallets only, directly via EIP-6963, popular on top (MetaMask, Rabby, Coinbase, OKX, Rainbow, Trust; not installed = "Install"), then any other installed wallet |
| `proof.js` | boundary price proof: headers N, N+1, N+2 (RLP, keccak = block hash) + `eth_getProof` of PoolManager slot0 of each pool of the asset path; `encodeForContract` = `ProofSubmission {version, boundary, BlockProof[3]}` |
| `eth.js` | keccak256, RLP, ABI coder, JSON-RPC with failover (browser and node) |
| `verify-proof.mjs` | `node verify-proof.mjs [T] [--verifier 0x… --rpc URL]`: builds the proof for the last full hour and checks it locally (MPT, EIP-2935, price); with `--verifier` also through the deployed BoundaryProofVerifier |
| `fonts/` | Inter (SIL OFL 1.1, `fonts/OFL.txt`), served from the site: no external files on load |

External requests are data `fetch` only: Ethereum RPCs (`RPCS`, `PROOF_RPCS`) and the chart API (`CHART_API`, GeckoTerminal). If the gateway blocks the chart API, the chart is simply not shown; `CHART_API: ""` turns it off.

Every order and claim also attaches proofs for the last UTC midnight and the current hour while they are unrecorded and provable (`AUTO_PROOFS`), so week and month start prices get recorded by any activity and those markets do not freeze. split/merge have no proof argument in the contract.

Proof RPCs: `eth_getProof` up to 27 h back needs an archive-capable endpoint; not every public RPC serves it.
