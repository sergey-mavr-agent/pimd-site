/* (p)IMD · config.js — the only file to edit when the contracts are live.
   ADAPTER "demo": fake book/portfolio/leaderboard, real IMD price.
   ADAPTER "chain": everything from PimdMarkets + BoundaryOracle + wallet. Fill CONTRACT and DEPLOY_BLOCK, then set ADAPTER. */
globalThis.CONFIG = {
  ADAPTER: "chain",                      // "demo" | "chain"
  CHAIN_ID: 1,                           // Ethereum mainnet
  // Several CORS-open public nodes for regular reads: one node rate-limiting fails over to the next instead of
  // breaking the page (a 429 without a CORS header reads to the browser as a misleading "CORS header missing").
  RPCS: ["https://eth-mainnet.public.blastapi.io", "https://rpc.mevblocker.io", "https://ethereum-rpc.publicnode.com", "https://eth.meowrpc.com", "https://eth.drpc.org"],
  // eth_getProof up to 27 h back needs an archive-capable, CORS-open endpoint; narrowed to the nodes that serve it.
  PROOF_RPCS: ["https://eth-mainnet.public.blastapi.io", "https://rpc.mevblocker.io"],
  CHART_API: "https://api.geckoterminal.com/api/v2/networks/eth/pools/",   // chart data (fetch only); "" = no chart

  CONTRACT: "0x6804ca9b86731056bb8e7976086c58e3e37047db",   // PimdMarkets
  ORACLE: "0x2ced79eba39ee972c6c4f7dd51a08f28dc034555",     // BoundaryOracle
  REGISTRY: "0x99bf2c49b25bdff7baa36a248bd27072c90dfa35",   // PimdRegistry
  DEPLOY_BLOCK: 26358290,
  ABI: null,                             // null = abi.js
  PIMD_TOKEN: "0xea377724af393671357bc2f565679e10b539139f",
  PERIOD_IDS: { "1H": 0, "1D": 1, "1W": 2, "1M": 3 },   // PimdRegistry periods created in its constructor
  // Orders and claims also prove these boundaries while unrecorded and < 27 h old (weeks/months then never freeze).
  AUTO_PROOFS: ["midnight"],             // hour boundaries are proved by claims of hourly markets (gas)

  // Ethereum facts
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  IMD: "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7",
  POOL_MANAGER: "0x000000000004444c5dc75cB358380D2e3dE08A90",
  POOL_IMD_ETH: "0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3",
  SLOTS: {                               // slot0 keys = keccak256(poolId, 6)
    IMD: "0xe4a8e4d1df3c332e13da9c3aae6f71f683236197cd0651438608c26f09255dd3",
    USDC: "0xda8cac368d67cd2f2d8aaa5cc531768e0fa3b1d205c5c5de60da078e1f59bdfc",
  },
  // Wallet: wallet.js, browser wallets only (EIP-6963).
};
