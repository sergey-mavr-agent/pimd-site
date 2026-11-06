/* (p)IMD · proof.js — IMD price at a boundary T and its on-chain proof package.
   Needs ETH (eth.js). Works in the browser and in node (fetch).
   Package: { T, chainId, poolManager, slots, blocks:[{number,hash,timestamp,stateRoot,headerRlp}] (N, N+1, N+2),
              accountProof:[nodes per block], storageProofs:[[{key,value,proof}] per pool per block], prices, price }
   encodeForContract(pkg, version) -> ProofSubmission for placeWithProofs / claimWithProofs. */
(function (root) {
  "use strict";
  const E = root.ETH || (typeof require !== "undefined" ? require("./eth.js") : null);
  const C = root.CONFIG || {};
  const PM = C.POOL_MANAGER || "0x000000000004444c5dc75cB358380D2e3dE08A90";
  // slot0 storage keys in PoolManager: keccak256(poolId, 6). IMD/ETH main pool, ETH/USDC pool.
  const SIMD = (C.SLOTS && C.SLOTS.IMD) || "0xe4a8e4d1df3c332e13da9c3aae6f71f683236197cd0651438608c26f09255dd3";
  const SUSD = (C.SLOTS && C.SLOTS.USDC) || "0xda8cac368d67cd2f2d8aaa5cc531768e0fa3b1d205c5c5de60da078e1f59bdfc";
  // proofs need archive-capable endpoints (eth_getProof up to 27 h back): CONFIG.PROOF_RPCS, else CONFIG.RPCS
  const rpc = (m, p) => E.rpc(m, p, C.PROOF_RPCS && C.PROOF_RPCS.length ? C.PROOF_RPCS : C.RPCS);
  const hx = n => "0x" + n.toString(16);

  // ---- price math (same as the demo): sqrtPriceX96 = low 160 bits of slot0
  const sqrtOf = word => BigInt(word) & ((1n << 160n) - 1n);
  const ratio = s => { const x = Number(s) / 2 ** 96; return x * x; };
  // IMD price in $ = (USDC per ETH) / (IMD per ETH); USDC 6 dec vs ETH 18 dec -> * 1e12
  const usdFromSlots = (wImd, wUsd) => ratio(sqrtOf(wUsd)) * 1e12 / ratio(sqrtOf(wImd));
  const median3 = a => [...a].sort((x, y) => x - y)[1];

  async function extsload(slot, block) { return rpc("eth_call", [{ to: PM, data: "0x1e2eaeaf" + slot.slice(2) }, block]); }
  async function usdAt(block) { const [i, u] = await Promise.all([extsload(SIMD, block), extsload(SUSD, block)]); return usdFromSlots(i, u); }

  // ---- block search: last block with timestamp <= T (seconds)
  const ts = async n => parseInt((await rpc("eth_getBlockByNumber", [hx(n), false])).timestamp, 16);
  async function head() { const h = parseInt(await rpc("eth_blockNumber", []), 16); return { h, hT: await ts(h) }; }
  async function blockAt(T, h, hT) {
    if (h == null) ({ h, hT } = await head());
    const age = Math.floor((hT - T) / 12), e = h - age, w = Math.floor(age * .02) + 120;
    let lo = Math.max(0, e - w), hi = Math.min(h, e + w);
    if ((await ts(lo)) > T) throw Error("blockAt: window too narrow");
    while (lo < hi) { const m = Math.floor((lo + hi + 1) / 2); (await ts(m)) <= T ? lo = m : hi = m - 1; }
    return lo;
  }

  // ---- header RLP. Field order of the execution block header (London..Prague).
  // kind: h = fixed bytes (hash/address/bloom/nonce), i = integer (minimal big-endian), b = byte string
  const HEADER = [
    ["parentHash", "h"], ["sha3Uncles", "h"], ["miner", "h"], ["stateRoot", "h"], ["transactionsRoot", "h"], ["receiptsRoot", "h"],
    ["logsBloom", "h"], ["difficulty", "i"], ["number", "i"], ["gasLimit", "i"], ["gasUsed", "i"], ["timestamp", "i"], ["extraData", "b"],
    ["mixHash", "h"], ["nonce", "h"],
    ["baseFeePerGas", "i"],          // London
    ["withdrawalsRoot", "h"],        // Shanghai
    ["blobGasUsed", "i"], ["excessBlobGas", "i"], ["parentBeaconBlockRoot", "h"], // Cancun
    ["requestsHash", "h"],           // Prague
  ];
  // JSON fields of eth_getBlockByNumber that are not part of the header
  const NOT_HEADER = new Set(["hash", "size", "totalDifficulty", "transactions", "uncles", "withdrawals", "sealFields", "author", "l1BlockNumber"]);
  function headerFields(b) {
    const known = new Set(HEADER.map(f => f[0])), extra = Object.keys(b).filter(k => !known.has(k) && !NOT_HEADER.has(k));
    if (extra.length) throw Error("header has new fields (" + extra.join(", ") + "): add them to HEADER in proof.js in fork order");
    const out = []; let optionalEnded = false;
    for (const [k, t] of HEADER) {
      if (b[k] === undefined) { optionalEnded = true; continue; }   // pre-fork blocks: trailing fields absent
      if (optionalEnded) throw Error("header: field " + k + " present after a missing one");
      out.push(t === "i" ? E.intToBytes(BigInt(b[k])) : E.hexToBytes(b[k]));
    }
    return out;
  }
  const headerRlp = b => E.rlpEncode(headerFields(b));

  async function getBlock(n) {
    const b = await rpc("eth_getBlockByNumber", [hx(n), false]);
    const rlp = headerRlp(b), h = E.keccakHex(rlp);
    if (h.toLowerCase() !== b.hash.toLowerCase()) throw Error("header hash mismatch at block " + n + ": " + h + " != " + b.hash);
    return { number: n, hash: b.hash, parentHash: b.parentHash, timestamp: parseInt(b.timestamp, 16), stateRoot: b.stateRoot, headerRlp: E.bytesToHex(rlp) };
  }

  // slot0 key of a v4 pool from its PoolKey {currency0, currency1, fee, tickSpacing, hooks} (as MarketTypes.slot)
  const POOLKEY = [{ type: "tuple", components: [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }] }];
  const poolId = k => E.keccakHex(E.abiEncode(POOLKEY, [[k.currency0 || k[0], k.currency1 || k[1], k.fee != null ? k.fee : k[2], k.tickSpacing != null ? k.tickSpacing : k[3], k.hooks || k[4]]]));
  const slotOf = k => E.keccakHex(E.abiEncode(["bytes32", "uint256"], [poolId(k), 6n]));
  // the IMD asset as PimdRegistry configures it in its constructor (version 1)
  const IMD_ASSET = {
    token: "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7", unitsPerShare: 10n ** 18n, maxOpenPairs: 10n ** 12n, hops: 2,
    path: [["0x0000000000000000000000000000000000000000", "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7", 10000, 200, "0x0000000000000000000000000000000000000000"],
           ["0x0000000000000000000000000000000000000000", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 500, 10, "0x0000000000000000000000000000000000000000"],
           ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", 0, 0, "0x0000000000000000000000000000000000000000"]],
  };

  // ---- build the package for boundary T (seconds). opt.slots = slot0 keys in the asset's path order (default IMD: IMD/ETH, ETH/USDC)
  async function build(T, opt) {
    opt = opt || {};
    const slots = opt.slots || [SIMD, SUSD], isImd = slots.length === 2 && slots[0].toLowerCase() === SIMD && slots[1].toLowerCase() === SUSD;
    const { h, hT } = opt.head || await head();
    if (hT < T) throw Error("boundary " + T + " is in the future");
    const N = opt.N != null ? opt.N : await blockAt(T, h, hT);
    if (N + 2 > h) throw Error("blocks N+1, N+2 not mined yet, retry in ~30 s");
    const blocks = [];
    for (let i = 0; i < 3; i++) blocks.push(await getBlock(N + i));
    if (!(blocks[0].timestamp <= T && T < blocks[1].timestamp)) throw Error("boundary not between N and N+1");
    for (let i = 1; i < 3; i++) if (blocks[i].parentHash.toLowerCase() !== blocks[i - 1].hash.toLowerCase()) throw Error("parentHash chain broken at " + blocks[i].number);
    const accountProof = [], storageProofs = [], prices = [];
    for (const b of blocks) {
      const p = await rpc("eth_getProof", [PM, slots, hx(b.number)]);
      accountProof.push(p.accountProof);
      storageProofs.push(p.storageProof.map(s => ({ key: s.key, value: s.value, proof: s.proof })));
      if (isImd) prices.push(usdFromSlots(p.storageProof[0].value, p.storageProof[1].value));
    }
    blocks.forEach(b => delete b.parentHash);
    return { T, chainId: 1, poolManager: PM, slots, blocks, accountProof, storageProofs, prices, price: prices.length ? median3(prices) : null };
  }

  // ---- contract argument: PimdMarkets.ProofSubmission
  //   { uint32 version; uint64 boundary; BlockProof[3] proofs }, BlockProof = { bytes header; bytes[] accountProof; bytes[][] storageProofs }
  //   storageProofs[j] = proof of slot0 of the j-th pool of the asset path. BoundaryOracle.prove takes (version, boundary, BlockProof[3]).
  const blockProofs = pkg => pkg.blocks.map((b, i) => [b.headerRlp, pkg.accountProof[i], pkg.storageProofs[i].map(s => s.proof)]);
  const encodeForContract = (pkg, version) => [Number(version || 1), BigInt(pkg.T), blockProofs(pkg)];
  const BLOCKPROOF = { type: "tuple", components: [{ type: "bytes" }, { type: "bytes[]" }, { type: "bytes[][]" }] };
  const SUBMISSION = { type: "tuple", components: [{ type: "uint32" }, { type: "uint64" }, { ...BLOCKPROOF, type: "tuple[3]" }] };
  const calldataSize = (pkg, version) => E.abiEncode([{ ...SUBMISSION, type: "tuple[]" }], [[encodeForContract(pkg, version)]]).length;

  const PimdProof = { PM, SIMD, SUSD, HEADER, IMD_ASSET, poolId, slotOf, head, ts, blockAt, getBlock, headerRlp, build, blockProofs, encodeForContract, calldataSize, usdAt, usdFromSlots, median3 };
  root.PimdProof = PimdProof;
  if (typeof module !== "undefined" && module.exports) module.exports = PimdProof;
})(typeof globalThis !== "undefined" ? globalThis : this);
