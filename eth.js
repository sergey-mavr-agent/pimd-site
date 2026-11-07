/* (p)IMD · eth.js — dependency-free Ethereum helpers for the browser and node.
   hex/bytes, keccak256, RLP, a small ABI coder, JSON-RPC with failover.
   Exposes globalThis.ETH (and module.exports under node). */
(function (root) {
  "use strict";

  // ---------- hex / bytes ----------
  const strip = h => (h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h);
  function hexToBytes(h) {
    h = strip(h); if (h.length % 2) h = "0" + h;
    const b = new Uint8Array(h.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
    return b;
  }
  const HX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
  function bytesToHex(b) { let s = "0x"; for (let i = 0; i < b.length; i++) s += HX[b[i]]; return s; }
  function concat(...a) { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; }
  function utf8(s) { return new TextEncoder().encode(s); }
  // minimal big-endian bytes of a non-negative integer (0 -> empty)
  function intToBytes(v) { v = BigInt(v); if (v === 0n) return new Uint8Array(0); let h = v.toString(16); if (h.length % 2) h = "0" + h; return hexToBytes(h); }
  function bytesToBig(b) { return b.length ? BigInt(bytesToHex(b)) : 0n; }
  function pad32(b, right) { if (b.length > 32) throw Error("pad32: too long"); const o = new Uint8Array(32); o.set(b, right ? 0 : 32 - b.length); return o; }
  function eqBytes(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

  // ---------- keccak256 (Keccak-f[1600], 32-bit lanes) ----------
  const RC = ["0000000000000001","0000000000008082","800000000000808a","8000000080008000","000000000000808b","0000000080000001","8000000080008081","8000000000008009","000000000000008a","0000000000000088","0000000080008009","000000008000000a","000000008000808b","800000000000008b","8000000000008089","8000000000008003","8000000000008002","8000000000000080","000000000000800a","800000008000000a","8000000080008081","8000000000008080","0000000080000001","8000000080008008"];
  const RCH = RC.map(x => parseInt(x.slice(0, 8), 16) | 0), RCL = RC.map(x => parseInt(x.slice(8), 16) | 0);
  // rotation offsets indexed by lane i = x + 5y
  const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
  const PI = []; for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) PI[x + 5 * y] = y + 5 * ((2 * x + 3 * y) % 5);
  function keccakF(s) {
    const C = new Int32Array(10), B = new Int32Array(50);
    for (let r = 0; r < 24; r++) {
      for (let x = 0; x < 5; x++) {
        C[2 * x] = s[2 * x] ^ s[2 * x + 10] ^ s[2 * x + 20] ^ s[2 * x + 30] ^ s[2 * x + 40];
        C[2 * x + 1] = s[2 * x + 1] ^ s[2 * x + 11] ^ s[2 * x + 21] ^ s[2 * x + 31] ^ s[2 * x + 41];
      }
      for (let x = 0; x < 5; x++) {
        const a = (x + 1) % 5, b = (x + 4) % 5, lo = C[2 * a], hi = C[2 * a + 1];
        const dl = C[2 * b] ^ ((lo << 1) | (hi >>> 31)), dh = C[2 * b + 1] ^ ((hi << 1) | (lo >>> 31));
        for (let y = 0; y < 25; y += 5) { s[2 * (x + y)] ^= dl; s[2 * (x + y) + 1] ^= dh; }
      }
      for (let i = 0; i < 25; i++) {
        let lo = s[2 * i], hi = s[2 * i + 1], n = ROT[i];
        if (n >= 32) { const t = lo; lo = hi; hi = t; n -= 32; }
        if (n) { const l2 = (lo << n) | (hi >>> (32 - n)), h2 = (hi << n) | (lo >>> (32 - n)); lo = l2; hi = h2; }
        const j = PI[i]; B[2 * j] = lo; B[2 * j + 1] = hi;
      }
      for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) {
        const i = x + y, i1 = ((x + 1) % 5) + y, i2 = ((x + 2) % 5) + y;
        s[2 * i] = B[2 * i] ^ (~B[2 * i1] & B[2 * i2]);
        s[2 * i + 1] = B[2 * i + 1] ^ (~B[2 * i1 + 1] & B[2 * i2 + 1]);
      }
      s[0] ^= RCL[r]; s[1] ^= RCH[r];
    }
  }
  function keccak256(data) {
    if (typeof data === "string") data = data.startsWith("0x") ? hexToBytes(data) : utf8(data);
    const rate = 136, s = new Int32Array(50), q = Math.floor(data.length / rate) * rate;
    const absorb = (blk) => { for (let i = 0; i < rate; i += 4) s[i >> 2] ^= blk[i] | (blk[i + 1] << 8) | (blk[i + 2] << 16) | (blk[i + 3] << 24); keccakF(s); };
    for (let off = 0; off < q; off += rate) absorb(data.subarray(off, off + rate));
    const last = new Uint8Array(rate); last.set(data.subarray(q)); last[data.length - q] ^= 0x01; last[rate - 1] ^= 0x80; absorb(last);
    const out = new Uint8Array(32); for (let i = 0; i < 32; i++) out[i] = (s[i >> 2] >>> ((i & 3) * 8)) & 255;
    return out;
  }
  const keccakHex = d => bytesToHex(keccak256(d));

  // ---------- RLP ----------
  function rlpLen(len, off) { if (len < 56) return Uint8Array.of(off + len); const l = intToBytes(len); return concat(Uint8Array.of(off + 55 + l.length), l); }
  function rlpEncode(x) {
    if (Array.isArray(x)) { const p = concat(...x.map(rlpEncode)); return concat(rlpLen(p.length, 0xc0), p); }
    if (typeof x === "string") x = hexToBytes(x);
    else if (typeof x === "number" || typeof x === "bigint") x = intToBytes(x);
    if (x.length === 1 && x[0] < 0x80) return x;
    return concat(rlpLen(x.length, 0x80), x);
  }
  // returns Uint8Array for strings, arrays for lists
  function rlpDecode(b) {
    if (typeof b === "string") b = hexToBytes(b);
    const [v, end] = dec(b, 0);
    if (end !== b.length) throw Error("rlp: trailing bytes");
    return v;
    function rd(p, n) { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; return v; }
    function dec(b, p) {
      const t = b[p]; if (t === undefined) throw Error("rlp: out of range");
      if (t < 0x80) return [b.subarray(p, p + 1), p + 1];
      if (t < 0xb8) { const n = t - 0x80; if (p + 1 + n > b.length) throw Error("rlp: short"); return [b.subarray(p + 1, p + 1 + n), p + 1 + n]; }
      if (t < 0xc0) { const ll = t - 0xb7, n = rd(p + 1, ll), s = p + 1 + ll; if (s + n > b.length) throw Error("rlp: short"); return [b.subarray(s, s + n), s + n]; }
      let s, n; if (t < 0xf8) { n = t - 0xc0; s = p + 1; } else { const ll = t - 0xf7; n = rd(p + 1, ll); s = p + 1 + ll; }
      const e = s + n; if (e > b.length) throw Error("rlp: short list"); const out = []; let q = s;
      while (q < e) { const [v, nq] = dec(b, q); out.push(v); q = nq; }
      if (q !== e) throw Error("rlp: bad list"); return [out, e];
    }
  }

  // ---------- ABI coder (subset: uint/int/address/bool/bytesN/bytes/string/arrays/tuples) ----------
  function canon(p) {
    const t = p.type, m = t.match(/^tuple(.*)$/);
    if (m) return "(" + p.components.map(canon).join(",") + ")" + m[1];
    return t === "uint" ? "uint256" : t === "int" ? "int256" : t;
  }
  const sig = f => f.name + "(" + (f.inputs || []).map(canon).join(",") + ")";
  const selector = f => bytesToHex(keccak256(utf8(typeof f === "string" ? f : sig(f))).subarray(0, 4));
  const topic0 = e => bytesToHex(keccak256(utf8(typeof e === "string" ? e : sig(e))));
  function arrInfo(t) { const m = t.match(/^(.*)\[(\d*)\]$/); return m ? { base: m[1], len: m[2] === "" ? null : +m[2] } : null; }
  function isDyn(p) {
    const t = p.type, a = arrInfo(t);
    if (t === "bytes" || t === "string") return true;
    if (a) return a.len === null || isDyn({ ...p, type: a.base });
    if (t === "tuple") return p.components.some(isDyn);
    return false;
  }
  function encOne(p, v) {
    const t = p.type, a = arrInfo(t);
    if (a) {
      const sub = { ...p, type: a.base }, items = Array.from(v), body = encList(items.map(() => sub), items);
      return a.len === null ? concat(pad32(intToBytes(items.length)), body) : body;
    }
    if (t === "tuple") return encList(p.components, Array.isArray(v) ? v : p.components.map(c => v[c.name]));
    if (t === "bytes" || t === "string") {
      const b = t === "string" ? utf8(v) : typeof v === "string" ? hexToBytes(v) : v;
      const padded = new Uint8Array(Math.ceil(b.length / 32) * 32); padded.set(b);
      return concat(pad32(intToBytes(b.length)), padded);
    }
    if (t === "address") return pad32(hexToBytes(v));
    if (t === "bool") return pad32(intToBytes(v ? 1 : 0));
    if (/^bytes\d+$/.test(t)) return pad32(typeof v === "string" ? hexToBytes(v) : v, true);
    if (/^u?int\d*$/.test(t)) {
      let x = BigInt(v); const bits = BigInt(t.replace(/^u?int/, "") || 256), signed = t[0] === "i";
      if (signed ? x < -(1n << (bits - 1n)) || x >= 1n << (bits - 1n) : x < 0n || x >= 1n << bits) throw Error("abi: " + v + " out of range for " + t);
      if (x < 0n) x = (1n << 256n) + x; return pad32(intToBytes(x));
    }
    throw Error("abi: unsupported type " + t);
  }
  function encList(ps, vs) {
    const heads = [], tails = []; let tailLen = 0;
    const headLen = ps.reduce((n, p) => n + (isDyn(p) ? 32 : staticSize(p)), 0);
    ps.forEach((p, i) => {
      const e = encOne(p, vs[i]);
      if (isDyn(p)) { heads.push(pad32(intToBytes(headLen + tailLen))); tails.push(e); tailLen += e.length; } else heads.push(e);
    });
    return concat(...heads, ...tails);
  }
  function staticSize(p) {
    const a = arrInfo(p.type);
    if (a) return a.len * staticSize({ ...p, type: a.base });
    if (p.type === "tuple") return p.components.reduce((n, c) => n + staticSize(c), 0);
    return 32;
  }
  function decOne(p, b, off) {
    // off = start of this value's encoding (decList already resolved dynamic offsets)
    const t = p.type, a = arrInfo(t), word = o => b.subarray(o, o + 32);
    if (a) {
      const sub = { ...p, type: a.base };
      let n = a.len, base = off;
      if (n === null) { n = Number(bytesToBig(word(off))); base = off + 32; }
      return decList(Array(n).fill(sub), b, base);
    }
    if (t === "tuple") { const vals = decList(p.components, b, off); p.components.forEach((c, i) => { if (c.name) vals[c.name] = vals[i]; }); return vals; }
    if (t === "bytes" || t === "string") {
      const n = Number(bytesToBig(word(off))), d = b.subarray(off + 32, off + 32 + n);
      return t === "string" ? new TextDecoder().decode(d) : bytesToHex(d);
    }
    const w = word(off);
    if (t === "address") return bytesToHex(w.subarray(12));
    if (t === "bool") return w[31] === 1;
    if (/^bytes\d+$/.test(t)) return bytesToHex(w.subarray(0, +t.slice(5)));
    if (/^uint\d*$/.test(t)) return bytesToBig(w);
    if (/^int\d*$/.test(t)) { const x = bytesToBig(w); return x >= 1n << 255n ? x - (1n << 256n) : x; }
    throw Error("abi: unsupported type " + t);
  }
  function decList(ps, b, base) {
    const out = []; let h = base;
    for (const p of ps) {
      if (isDyn(p)) { out.push(decOne(p, b, base + Number(bytesToBig(b.subarray(h, h + 32))))); h += 32; }
      else { out.push(decOne(p, b, h)); h += staticSize(p); }
    }
    return out;
  }
  const abiEncode = (types, values) => encList(types.map(t => typeof t === "string" ? { type: t } : t), values);
  const abiDecode = (types, data) => decList(types.map(t => typeof t === "string" ? { type: t } : t), typeof data === "string" ? hexToBytes(data) : data, 0);
  function fnOf(abi, name) {
    const f = abi.find(x => x.type === "function" && (x.name === name || sig(x) === name));
    if (!f) throw Error("ABI: function " + name + " not found (fill ABI in config.js)");
    return f;
  }
  const encodeCall = (abi, name, args) => { const f = fnOf(abi, name); return bytesToHex(concat(hexToBytes(selector(f)), abiEncode(f.inputs, args || []))); };
  function decodeResult(abi, name, data) { const f = fnOf(abi, name), v = abiDecode(f.outputs || [], data); (f.outputs || []).forEach((o, i) => { if (o.name) v[o.name] = v[i]; }); return v; }
  // decode a log with the matching event in abi; returns null if unknown
  function decodeLog(abi, log) {
    const evs = abi.filter(x => x.type === "event"), ev = evs.find(e => topic0(e) === log.topics[0]);
    if (!ev) return null;
    const args = {}, idx = ev.inputs.filter(i => i.indexed), non = ev.inputs.filter(i => !i.indexed);
    idx.forEach((p, i) => { const tp = hexToBytes(log.topics[i + 1]); args[p.name] = isDyn(p) ? bytesToHex(tp) : decOne(p, tp, 0); });
    const vals = abiDecode(non, log.data); non.forEach((p, i) => { args[p.name] = vals[i]; });
    return { name: ev.name, args, blockNumber: parseInt(log.blockNumber, 16), logIndex: parseInt(log.logIndex, 16), tx: log.transactionHash };
  }

  // ---------- JSON-RPC with failover ----------
  // an endpoint that fails at the network level, rate-limits (429) or never answers is benched for 30 s.
  // RPC_TIMEOUT_MS: a stalling endpoint (connects but never responds, no error) must not hang the caller
  // forever — fetch() with no abort signal waits indefinitely: one stuck endpoint fills the browser's
  // 6-connections-per-origin limit, so every later request to it, including the one the click needs,
  // queues behind it and never even starts.
  let rr = 0, rid = 0;
  const bench = new Map();
  const RPC_TIMEOUT_MS = 10000;
  // opt.allowNull: a null result is an answer (pending receipt), not a failure
  async function rpc(method, params, rpcs, opt) {
    rpcs = rpcs || (root.CONFIG && root.CONFIG.RPCS) || ["https://eth-mainnet.public.blastapi.io"];
    let last;
    for (let k = 0; k < 2 * rpcs.length; k++) {
      const now = Date.now(), up = rpcs.filter(u => !(bench.get(u) > now)), pool = up.length ? up : rpcs;
      const url = pool[(rr++) % pool.length];
      const ac = new AbortController(), timer = setTimeout(() => ac.abort(), RPC_TIMEOUT_MS);
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }), signal: ac.signal });
        if (r.status === 429) { bench.set(url, Date.now() + 30e3); last = "rate limited"; continue; }
        const j = await r.json();
        if (j.result !== undefined && (j.result !== null || (opt && opt.allowNull))) return j.result;
        // a revert is an answer, not a node failure: stop and keep the revert data
        if (j.error && (j.error.code === 3 || /revert/i.test(j.error.message || ""))) { const er = Error(j.error.message || "execution reverted"); er.data = j.error.data; er.revert = true; throw er; }
        last = j.error ? j.error.message : "null result";
      } catch (e) {
        if (e.revert) throw e;
        last = e.name === "AbortError" ? "timed out after " + RPC_TIMEOUT_MS + "ms" : e.message;
        if (e.name === "TypeError" || e.name === "AbortError") bench.set(url, Date.now() + 30e3);
      } finally { clearTimeout(timer); }
    }
    throw Error(method + ": " + last);
  }

  // revert data -> readable name: Error(string), Panic(uint256) or a custom error from the given ABIs
  function decodeError(abis, data) {
    if (data && typeof data === "object") data = data.data || data.originalError && data.originalError.data;
    if (typeof data !== "string" || data.length < 10) return null;
    const sel = data.slice(0, 10).toLowerCase();
    if (sel === "0x08c379a0") return abiDecode(["string"], "0x" + data.slice(10))[0];
    if (sel === "0x4e487b71") return "Panic(" + abiDecode(["uint256"], "0x" + data.slice(10))[0] + ")";
    for (const abi of abis) for (const x of abi) if (x.type === "error" && selector(x) === sel) return x.name;
    return null;
  }

  const ETH = { decodeError, strip, hexToBytes, bytesToHex, concat, utf8, intToBytes, bytesToBig, pad32, eqBytes, keccak256, keccakHex, rlpEncode, rlpDecode, sig, selector, topic0, abiEncode, abiDecode, encodeCall, decodeResult, decodeLog, fnOf, rpc };
  root.ETH = ETH;
  if (typeof module !== "undefined" && module.exports) module.exports = ETH;
})(typeof globalThis !== "undefined" ? globalThis : this);
