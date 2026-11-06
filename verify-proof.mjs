// (p)IMD · verify-proof.mjs — build the boundary proof for the last passed full hour and check it locally.
// Run: node verify-proof.mjs [unixSeconds] [--verifier 0xAddr [--rpc URL]]
//   --verifier: also eth_call BoundaryProofVerifier.verify(T, IMD asset, proofs) and compare its price (1e18 USD)
// Checks: keccak(headerRlp) == block hash, parentHash links, EIP-2935 history hash, MPT account proof
// against the header's stateRoot, MPT storage proofs against the account's storageRoot, and the
// median-of-3 IMD price from the proven slots == the price from eth_call (as the site computes it).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("./config.js");
const E = require("./eth.js");
const P = require("./proof.js");
const ABI = require("./abi.js");
const argv = process.argv.slice(2), flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const VERIFIER = flag("--verifier"), VRPC = flag("--rpc");
const Targ = argv.find(a => /^\d+$/.test(a));

// independent keccak for the checks (noble), fall back to ours if it is not installed
let keccak = E.keccak256, kname = "eth.js";
try {
  const { keccak_256 } = require("@noble/hashes/sha3.js");
  keccak = b => keccak_256(b); kname = "@noble/hashes";
} catch (e) { /* noble not available */ }
const K = b => E.bytesToHex(keccak(typeof b === "string" ? E.hexToBytes(b) : b));
const HISTORY = "0x0000F90827F1C53a10cb7A02335B175320002935"; // EIP-2935

// ---- Merkle Patricia proof verifier: returns the leaf value (Uint8Array) or null for a proven absence
function nibbles(b) { const n = []; for (const x of b) n.push(x >> 4, x & 15); return n; }
function hp(b) { const nb = nibbles(b), f = nb[0]; return { leaf: f >= 2, path: nb.slice(f & 1 ? 1 : 2) }; }
function mptVerify(rootHex, keyBytes, proof) {
  const path = nibbles(keccak(keyBytes)), byHash = new Map(proof.map(n => [K(n), E.rlpDecode(n)]));
  let ref = E.hexToBytes(rootHex), node, i = 0;
  for (let steps = 0; steps < 64; steps++) {
    if (Array.isArray(ref)) node = ref;                                // embedded node (< 32 bytes)
    else if (ref.length === 0) return null;                            // empty branch slot
    else { node = byHash.get(E.bytesToHex(ref)); if (!node) throw Error("missing proof node " + E.bytesToHex(ref)); }
    if (node.length === 17) {
      if (i === path.length) return node[16];
      ref = node[path[i++]];
    } else if (node.length === 2) {
      const { leaf, path: np } = hp(node[0]);
      const rest = path.slice(i, i + np.length);
      if (rest.length !== np.length || rest.some((x, j) => x !== np[j])) return null; // diverges: key absent
      i += np.length;
      if (leaf) { if (i !== path.length) throw Error("leaf before end of key"); return node[1]; }
      ref = node[1];
    } else throw Error("bad node with " + node.length + " items");
  }
  throw Error("proof too deep");
}

const ok = [], fail = [];
const check = (name, cond, info) => { (cond ? ok : fail).push(name + (info ? " · " + info : "")); return cond; };

function verifyPackage(pkg, quiet) {
  const res = { ok: true, prices: [] };
  const c = (n, v, i) => { if (!quiet) check(n, v, i); if (!v) res.ok = false; return v; };
  const hs = pkg.blocks.map(b => E.rlpDecode(b.headerRlp));
  pkg.blocks.forEach((b, i) => {
    c(`block ${b.number}: keccak(headerRlp) == hash`, K(b.headerRlp) === b.hash.toLowerCase());
    c(`block ${b.number}: number in header`, Number(E.bytesToBig(hs[i][8])) === b.number);
    if (i) c(`block ${b.number}: parentHash == hash(${b.number - 1})`, E.bytesToHex(hs[i][0]) === pkg.blocks[i - 1].hash.toLowerCase());
  });
  const t0 = Number(E.bytesToBig(hs[0][11])), t1 = Number(E.bytesToBig(hs[1][11]));
  c(`timestamp(N)=${t0} <= T=${pkg.T} < timestamp(N+1)=${t1}`, t0 <= pkg.T && pkg.T < t1);
  const acct = E.hexToBytes(pkg.poolManager);
  pkg.blocks.forEach((b, i) => {
    const stateRoot = E.bytesToHex(hs[i][3]);
    let acc; try { acc = mptVerify(stateRoot, acct, pkg.accountProof[i]); } catch (e) { acc = null; }
    if (!c(`block ${b.number}: account proof vs stateRoot`, !!acc, acc ? "" : "invalid")) return;
    const [nonce, bal, storageRoot, codeHash] = E.rlpDecode(acc);
    const vals = pkg.storageProofs[i].map((sp, j) => {
      let v; try { v = mptVerify(E.bytesToHex(storageRoot), E.pad32(E.hexToBytes(sp.key)), sp.proof); } catch (e) { v = undefined; }
      const got = v ? E.bytesToBig(E.rlpDecode(v)) : 0n;
      c(`block ${b.number}: storage proof ${j ? "ETH/USDC" : "IMD/ETH"} slot0 vs storageRoot`, v !== undefined && got === BigInt(sp.value));
      return "0x" + got.toString(16);
    });
    res.prices.push(P.usdFromSlots(vals[0], vals[1]));
  });
  res.price = res.prices.length === 3 ? P.median3(res.prices) : NaN;
  return res;
}

async function main() {
  const { h, hT } = await P.head();
  let T = Targ ? +Targ : Math.floor(hT / 3600) * 3600;
  if (!Targ && hT - T < 40) T -= 3600;            // N+2 must be mined
  console.log(`boundary T = ${T} (${new Date(T * 1e3).toISOString().replace(".000Z", "Z")}), head ${h}, keccak for checks: ${kname}`);
  const t = Date.now(), pkg = await P.build(T, { head: { h, hT } });
  console.log(`package built in ${((Date.now() - t) / 1e3).toFixed(1)} s: blocks ${pkg.blocks.map(b => b.number).join(", ")}, ` +
    `${JSON.stringify(pkg).length} bytes JSON, ProofSubmission calldata ${P.calldataSize(pkg, 1)} bytes`);

  const r = verifyPackage(pkg);
  // EIP-2935: the newest header hash as the contract will see it
  try {
    const got = await E.rpc("eth_call", [{ to: HISTORY, data: E.bytesToHex(E.pad32(E.intToBytes(pkg.blocks[2].number))) }, "latest"], CONFIG.RPCS);
    check(`EIP-2935 history hash of ${pkg.blocks[2].number}`, got.toLowerCase() === pkg.blocks[2].hash.toLowerCase());
  } catch (e) { check("EIP-2935 history call", false, e.message); }
  // price as the site computes it (eth_call extsload at each block, median)
  const called = await Promise.all(pkg.blocks.map(b => P.usdAt("0x" + b.number.toString(16))));
  const pc = P.median3(called);
  check(`price from proofs == price from eth_call`, Math.abs(r.price - pc) <= 1e-12 * pc, `$${r.price.toFixed(6)} vs $${pc.toFixed(6)}`);
  // the real contract verifier when deployed / forked
  if (VERIFIER) {
    const A = P.IMD_ASSET, asset = [A.token, A.unitsPerShare, A.maxOpenPairs, A.hops, A.path];
    try {
      const data = E.encodeCall(ABI.verifier, "verify", [BigInt(T), asset, P.blockProofs(pkg)]);
      const out = await E.rpc("eth_call", [{ to: VERIFIER, data }, "latest"], VRPC ? [VRPC] : CONFIG.RPCS);
      const [p18] = E.decodeResult(ABI.verifier, "verify", out), pv = Number(p18) / 1e18;
      check(`BoundaryProofVerifier.verify on ${VERIFIER.slice(0, 10)}…`, Math.abs(pv - r.price) <= 1e-9 * r.price, `$${pv.toFixed(6)} (${p18} / 1e18)`);
    } catch (e) { check("BoundaryProofVerifier.verify", false, e.message.slice(0, 200)); }
  }
  // negative tests: the verifier must reject tampered packages
  const bad1 = structuredClone(pkg); const sp = bad1.storageProofs[1][0]; sp.value = "0x" + (BigInt(sp.value) + 1n).toString(16);
  check("tampered slot value is rejected", !verifyPackage(bad1, true).ok);
  const bad2 = structuredClone(pkg); const ap = bad2.accountProof[0], last = ap[ap.length - 1]; ap[ap.length - 1] = last.slice(0, -2) + (last.slice(-2) === "00" ? "01" : "00");
  check("tampered account proof is rejected", !verifyPackage(bad2, true).ok);
  const bad3 = structuredClone(pkg); bad3.blocks[1].headerRlp = bad3.blocks[1].headerRlp.replace(/.$/, c => c === "0" ? "1" : "0");
  check("tampered header is rejected", !verifyPackage(bad3, true).ok);

  for (const s of ok) console.log("  ok   " + s);
  for (const s of fail) console.log("  FAIL " + s);
  console.log(`prices per block: ${r.prices.map(x => "$" + x.toFixed(6)).join(", ")}`);
  if (fail.length) { console.log(`ERROR: ${fail.length} check(s) failed`); process.exit(1); }
  console.log(`OK · IMD = $${r.price.toFixed(6)} at ${new Date(T * 1e3).toISOString().slice(0, 16).replace("T", " ")} UTC (median of blocks ${pkg.blocks[0].number}..${pkg.blocks[2].number}), ${ok.length} checks passed`);
}
main().catch(e => { console.log("ERROR: " + e.message); process.exit(1); });
