/* (p)IMD · api.js — the data layer of the site. Two adapters with the same interface:
   demo  — the fake book, volumes, portfolio and leaderboard of the demo;
   chain — PimdMarkets + BoundaryOracle (abi.js) via public RPC (reads) and WALLET (writes).
   Reads are synchronous: they return the cached value (or null while loading) and refresh in the
   background, then call ctx.render(). Writes are async and resolve with a tx hash ("demo" in demo).

   Market descriptor passed by the page: C = {k: "1H"|"1D"|"1W"|"1M", a: start ms, b: end ms, K?: ladder strike $}.
   Prices on the page are in the coin of the side: UP in USDC per share, DOWN in IMD per share.
   In the contract there is one mirrored book with x = USDC per UP share; DOWN at y IMD <=> x = V - y*live. */
(function (root) {
  "use strict";
  const E = root.ETH, P = root.PimdProof, W = root.WALLET;

  // ======================================================================= demo
  function demoAdapter(ctx) {
    const mult = k => k === "1H" ? 1 : k === "1D" ? 4 : k === "1W" ? 9 : 15;
    function rng(n) { let x = n * 9301 + 49297; return () => ((x = (x * 9301 + 49297) % 233280) / 233280); }
    const sent = async () => "demo";
    return {
      name: "demo", demo: true,
      heroStats: () => ({ markets: 4, vol24: 31200, paid: 118000 }),
      volume: C => 3100 * mult(C.k),
      ladderVolume: k => 1400 * (k === "1H" ? 1 : k === "1D" ? 3 : k === "1W" ? 6 : 11),
      // synthetic book around the model probability q (as in the demo)
      book(C, side, { q, v, live }) {
        const U = side === "UP", qm = U ? q : 1 - q, qp = x => x * v / (U ? 1 : (live || 1));
        const asks = [4, 3, 2, 1].map(i => [qp(Math.min(.995, qm + .006 * i)), [70, 214, 20, 11][4 - i]]);
        const bids = [1, 2, 3, 4].map(i => [qp(Math.max(.005, qm - .006 * i)), [55, 300, 120, 40][i - 1]]);
        return { asks, bids, last: qp(qm) };
      },
      portfolio(addr, { v, live }) {
        const L = live || 2.45;
        const positions = [["1H", 0, "UP", 24, .61], ["1D", 0, "DOWN", 40, .52], ["1W", 0, "UP", 15, .44]].map(([k, o, sd, n, q]) => {
          const C = ctx.mk(k, o), qn = sd === "UP" ? ctx.qUp(C) : 1 - ctx.qUp(C);
          return { k, o, sd, n, cost: n * q * v, val: n * qn * v };
        });
        const orders = [["1H", 1, "Buy", "UP", .55, 30, "in 52m"], ["1D", 0, "Sell", "DOWN", .62, 10, "market end"], ["1W", 0, "Buy", "DOWN", .48, 20, "in 2d"]]
          .map(([k, o, action, sd, q, n, expires], i) => ({ id: i + 1, k, o, action, sd, price: sd === "UP" ? q * v : (1 - q) * v / L, n, filled: 0, expires }));
        const claims = [["1H", -1, "UP", "Won", 12, 12], ["1H", -3, "DOWN", "Won", 8, 8], ["1D", -1, "UP", "Refund · order not filled", 5.4, 0]]
          .map(([k, o, sd, result, usdc, imd]) => ({ k, o, sd, result, usdc, imd }));
        const history = [["17:04", "1H", 0, "Buy Up", 24, .61], ["16:58", "1D", 0, "Buy Down", 40, .48], ["16:20", "1H", -1, "Claim", 12, 1], ["15:47", "1H", -1, "Buy Up", 12, .42], ["15:12", "1W", 0, "Buy Up", 15, .44], ["14:03", "1H", -2, "Buy Up", 15, .57]]
          .map(([time, k, o, action, n, q]) => ({ time, k, o, action, n, priceUsd: action === "Claim" ? null : q * v, feeUsd: action === "Claim" ? 0 : .07 * q * (1 - q) * v * n }));
        const posVal = positions.reduce((a, x) => a + x.val, 0), claimUsd = (12 + 8) * v + 5.4;
        return { value: posVal + claimUsd + 212, pnl: 184.2, volume: 3420, wins: 23, trades: 40, balance: { usdc: 150, imd: 25 }, positions, orders, claims, claimUsd, history };
      },
      leaderboard(per, mk) {
        const r = rng(({ day: 1, week: 2, month: 3, all: 4 })[per] * 7 + ({ all: 0, "1H": 1, "1D": 2, "1W": 3, "1M": 4 })[mk]), f = ({ day: .15, week: 1, month: 3.5, all: 9 })[per] * (mk === "all" ? 1 : .4);
        return Array.from({ length: 25 }, () => {
          const vol = Math.round((800 + r() * 24000) * f), pnl = (r() - .32) * vol * .22, tr = Math.round(5 + r() * 180 * f), wr = .35 + r() * .35;
          return { w: "0x" + Math.floor(r() * 65535).toString(16).padStart(4, "0") + "…" + Math.floor(r() * 65535).toString(16).padStart(4, "0"), vol, pnl, tr, wr };
        });
      },
      boundary: () => null,                  // demo: strikes come from RPC only
      balance: () => ({ usdc: 150, imd: 25, credit: 0 }),
      // writes: nothing is sent
      order: async () => { ctx.how(); return null; },
      cancel: sent, cancelAll: sent, split: sent, merge: sent, claim: sent, claimAll: sent,
      deposit: sent, withdraw: sent, proposePrice: sent, dispute: sent, finalize: sent, withdrawCredit: sent,
    };
  }

  // ====================================================================== chain
  // Contracts: PimdMarkets + BoundaryOracle + PimdRegistry (abi.js).
  // Units: shares, USDC and book prices x (USDC per UP share) have 6 decimals; IMD 18; boundary prices are USD * 1e18.
  function chainAdapter(ctx) {
    const cfg = root.CONFIG, A = cfg.ABI || root.PIMD_ABI || {}, AM = A.markets || [], AO = A.oracle || [], AR = A.registry || [];
    const ready = () => !!(cfg.CONTRACT && AM.length);
    const ZERO = "0x0000000000000000000000000000000000000000", BOND = 10n ** 19n;   // 10 IMD
    const u6 = x => BigInt(Math.floor(x * 1e6 + 1e-6)), f6 = x => Number(x) / 1e6;
    const u18 = x => BigInt(Math.round(x * 1e6)) * 10n ** 12n, f18 = x => Number(BigInt(x) / 10n ** 12n) / 1e6;
    const PER = cfg.PERIOD_IDS, KOF = Object.fromEntries(Object.entries(PER).map(([k, v]) => [v, k]));
    const ACT = { BuyUp: 0, BuyDown: 1, SellUp: 2, SellDown: 3 }, isDown = a => a === 1 || a === 3, isBid = a => a === 0 || a === 3;
    const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
    const warned = new Set();
    const warn = (k, e) => { if (!warned.has(k)) { warned.add(k); console.warn("[pimd chain] " + k + ": " + (e && e.message || e)); } };

    // ---- cache: value now, refresh in background
    const cache = new Map();
    function memo(key, ttl, fn) {
      const c = cache.get(key), now = Date.now();
      if (!c || (!c.p && now - c.t > ttl)) {
        const e = c || { v: null, t: 0 }; cache.set(key, e);
        e.p = Promise.resolve().then(fn).then(v => { e.v = v; e.err = null; }, err => { e.err = err; warn(key, err); })
          .finally(() => { e.t = Date.now(); e.p = null; ctx.render(); });
      }
      return cache.get(key).v;
    }
    const invalidate = () => { for (const e of cache.values()) e.t = 0; };

    // ---- contract I/O
    const rpc = (m, p, o) => E.rpc(m, p, cfg.RPCS, o);
    const NICE = {
      InsufficientBalance: "Not enough free balance or shares. Deposit first.", MissingPrice: "No IMD price recorded on-chain yet.",
      InvalidOrder: "Order rejected: check price (tick 0.0001), size (min 1 USDC) and expiry.", InvalidMarket: "This market is not open.",
      InsertionHintRequired: "The book is deep at this price: try a price closer to the best one.", InvalidState: "Not possible right now (window closed or already done).",
      InvalidPayment: "Bond payment failed: check IMD in your wallet.", InvalidHeaders: "Price proof rejected: retry in a minute.",
      Unauthorized: "Not your order.", InvalidTransfer: "Token transfer failed.",
    };
    const nice = e => { const n = E.decodeError([AM, AO, AR], e.data || e); return n ? Error(NICE[n] || n) : e; };
    async function callC(to, abi, fn, args) {
      if (!ready()) throw Error("Contract not configured yet (config.js: CONTRACT)");
      try { return E.decodeResult(abi, fn, await rpc("eth_call", [{ to, data: E.encodeCall(abi, fn, args || []) }, "latest"])); }
      catch (e) { throw nice(e); }
    }
    const mkt = (fn, args) => callC(cfg.CONTRACT, AM, fn, args);
    let ADDR = null;
    async function addrs() {
      if (!ADDR) { const [o] = await mkt("oracle"), [r] = await mkt("registry"); ADDR = { oracle: cfg.ORACLE || o, registry: cfg.REGISTRY || r }; }
      return ADDR;
    }
    const orc = async (fn, args) => callC((await addrs()).oracle, AO, fn, args);
    const reg = async (fn, args) => callC((await addrs()).registry, AR, fn, args);
    let VER = null;
    async function version() { if (!VER) VER = Number((await reg("currentVersion", [cfg.IMD]))[0]); return VER; }
    async function pathSlots(v) { const [a] = await reg("asset", [v]); return a.path.slice(0, Number(a.hops)).map(P.slotOf); }

    async function waitReceipt(hash) {
      for (let i = 0; i < 180; i++) {
        const r = await rpc("eth_getTransactionReceipt", [hash], { allowNull: true }).catch(() => null);
        if (r) { if (r.status !== "0x1") throw Error("Transaction failed on-chain: " + hash); return r; }
        await new Promise(s => setTimeout(s, 2000));
      }
      throw Error("No confirmation after 6 min: " + hash);
    }
    // all writes go through WALLET.sendTx (EIP-6963 or any added option); dry run first for a readable revert
    async function sendRaw(to, data) {
      if (!W.address) { ctx.connect(); throw Error("Connect a wallet first"); }
      // the dry-run eth_call before signing can take a while on a busy node; past 15s tell the user
      // we're still checking instead of leaving a dead-looking button, past 45s give up with a clear error.
      const slow = setTimeout(() => ctx.toast("Checking the order…"), 15000);
      try {
        await Promise.race([
          rpc("eth_call", [{ from: W.address, to, data }, "latest"]).catch(e => { throw nice(e); }),
          new Promise((_, rej) => setTimeout(() => rej(Error("The order check is taking too long. Try again in a minute.")), 45000)),
        ]);
      } finally { clearTimeout(slow); }
      const hash = await W.sendTx({ to, data });
      ctx.toast("Sent · waiting for confirmation…");
      await waitReceipt(hash); invalidate(); return hash;
    }
    const send = (fn, args) => ready() ? sendRaw(cfg.CONTRACT, E.encodeCall(AM, fn, args)) : Promise.reject(Error("Contract not configured yet (config.js: CONTRACT)"));
    const sendOracle = async (fn, args) => sendRaw((await addrs()).oracle, E.encodeCall(AO, fn, args));
    const ERC20 = [
      { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
      { type: "function", name: "allowance", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
    ];
    async function approveIfNeeded(token, spender, amount) {
      const [al] = E.decodeResult(ERC20, "allowance", await rpc("eth_call", [{ to: token, data: E.encodeCall(ERC20, "allowance", [W.address, spender]) }, "latest"]));
      if (al >= amount) return;
      ctx.toast("Approve the token in your wallet");
      await sendRaw(token, E.encodeCall(ERC20, "approve", [spender, amount]));
    }

    // ---- markets: MarketSpec {token, period, start, strike}; strike = ladder K in USD*1e18, 0 for Up/Down
    const spec = C => [cfg.IMD, PER[C.k], BigInt(Math.floor(C.a / 1e3)), C.K ? u18(C.K) : 0n];
    const idOf = C => E.keccakHex(E.abiEncode(["address", "uint32", "uint64", "uint256"], spec(C)));

    // ---- boundary prices (BoundaryOracle.price[version][T]) and the optimistic fallback
    function boundary(Tms) {
      if (!ready()) return null;
      return memo("bnd:" + Tms, 30e3, async () => {
        const v = await version(), T = BigInt(Math.floor(Tms / 1e3)), [p] = await orc("price", [v, T]);
        if (p > 0n) return { recorded: true, price: f18(p), priceable: true };
        const [id] = await orc("proposalId", [v, T]), [pr] = await orc("proposal", [id]);
        const proposal = pr.proposer === ZERO ? null : { by: pr.proposer, price: f18(pr.proposed), deadline: Number(pr.deadline) * 1e3, disputed: pr.challenger !== ZERO, finished: pr.finished };
        // priceable = false: the price can no longer be recorded, markets starting here are frozen and will void
        const [priceable] = await orc("priceable", [v, T]);
        return { recorded: false, price: null, proposal, priceable };
      });
    }
    // ProofSubmission[] for past boundaries that are not recorded yet, in priority order, max 2 (contract limit).
    // Built from the public RPC; a boundary recorded meanwhile by someone else is skipped by the contract.
    async function proofsFor(list) {
      const v = await version(), subs = []; let price = null;
      for (const Tms of [...new Set(list.filter(Boolean))]) {
        if (subs.length >= 2) break;
        if (Tms > Date.now() - 40e3 || Date.now() - Tms > 27 * 36e5) continue;   // not mined yet / proof window closed
        try {
          const T = BigInt(Math.floor(Tms / 1e3)), [p] = await orc("price", [v, T]);
          if (p > 0n) continue;
          ctx.toast("Building the price proof…");
          const pkg = await P.build(Number(T), { slots: await pathSlots(v) });
          subs.push(P.encodeForContract(pkg, v)); price = pkg.price;
        } catch (e) {
          // One boundary failing to build (RPC hiccup, proof window edge) must not abort the others in
          // this list: AUTO_PROOFS boundaries are an opportunistic side-effect of the order, not required
          // for it — a failed proof here must not void the whole order or claim.
          ctx.toast(`Price record for ${new Date(Tms).toISOString().slice(0, 16)} skipped: ${String(e.message || e).slice(0, 80)}`);
        }
      }
      return { subs, price };
    }
    // Every user transaction that can carry proofs (order, claim) also records the last UTC midnight and the
    // current hour boundary while they are provable: week and month start prices get recorded by any activity,
    // so those markets never freeze. split/merge have no proof argument in the contract.
    // Which ones: CONFIG.AUTO_PROOFS ("midnight", "hour"). Each proof costs ~5.5M gas, paid by that user.
    const autoBoundaries = () => {
      const n = Date.now(), want = cfg.AUTO_PROOFS || ["midnight", "hour"];
      return [want.includes("midnight") && Math.floor(n / 864e5) * 864e5, want.includes("hour") && Math.floor(n / 36e5) * 36e5];
    };

    // ---- fee budget escrowed with an order (taker rate, worst price the order can fill at), PimdMarkets._fee
    // Must be >= feeQuote at the limit price (contract floor). p18s: the price now on-chain and the one an attached
    // proof will record first (the contract then uses the newest); the largest budget of them is taken.
    function feeBudget(action, x6, qty6, p18s) {
      let best = 0n;
      for (const p18 of [].concat(p18s).filter(Boolean)) {
        const p = Number(p18) / 1e18, V = 1 + p, qx = Math.min(.99, Math.max(.01, Number(x6) / 1e6 / V));
        const qq = isBid(action) ? Math.min(qx, .5) : Math.max(qx, .5), usd = qq * (1 - qq) * V * .07 * Number(qty6) / 1e6 * 1.03;
        const b = isDown(action) ? u18(usd / p) + 10n ** 9n : u6(usd) + 2n;
        if (b > best) best = b;
      }
      return best;
    }

    // ---- event index (no backend): all PimdMarkets logs since DEPLOY_BLOCK
    const LOGS = { from: cfg.DEPLOY_BLOCK || 0, list: [], head: 0, headT: 0 };
    async function syncLogs() {
      const head = parseInt(await rpc("eth_blockNumber", []), 16);
      let from = LOGS.from, step = 20000;
      while (from <= head) {
        const to = Math.min(head, from + step - 1);
        try {
          const logs = await rpc("eth_getLogs", [{ address: cfg.CONTRACT, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
          for (const l of logs) { const d = E.decodeLog(AM, l); if (d) LOGS.list.push(d); }
          from = to + 1; LOGS.from = from;
          step = Math.min(20000, step * 2); // rpc() already round-robins CONFIG.RPCS per call, so the
          // provider that capped the last range may not be picked next time - grow step back up rather
          // than crawl the rest of the index at the smallest width any one provider ever demanded
        } catch (e) {
          // some free RPCs cap eth_getLogs far below our 20000-block step (seen: blastapi "up to a 10
          // block range" on this range) - their error names the exact width that will work, use it
          // directly instead of /4-backoff bottoming out at 500 and giving up above their real cap
          const m = /up to an? (\d+) block range/i.exec(e.message || "");
          if (m) { step = Math.max(1, +m[1]); continue; }
          if (step <= 1) throw e;
          step = Math.max(1, Math.floor(step / 4));
        }
      }
      LOGS.head = head; LOGS.headT = Date.now();
      return { n: LOGS.list.length, list: LOGS.list };
    }
    const events = () => ready() ? memo("logs", 20e3, syncLogs) : null;
    const timeOf = bn => new Date(LOGS.headT - (LOGS.head - bn) * 12e3).toISOString().slice(11, 16);
    // indexes over the event list: markets, orders (trader/action), fills
    let IX = { n: -1 };
    function index() {
      const ev = events(); if (!ev) return null;
      if (IX.n === ev.n) return IX;
      const mk = {}, ord = {}, fills = [], claims = [], my = [];
      for (const e of ev.list) {
        const a = e.args;
        if (e.name === "MarketCreated") { const k = KOF[Number(a.period)], s = Number(a.start) * 1e3; mk[a.market] = { k, a: s, b: Number(a.end) * 1e3, K: a.ladderStrike ? f18(a.ladderStrike) : 0, id: a.market }; }
        else if (e.name === "OrderPlaced") ord[String(a.order)] = { id: a.order, market: a.market, trader: a.trader, action: Number(a.action), qty: f6(a.quantity), x: f6(a.price), expiry: Number(a.expiry) * 1e3, filled: 0, closed: false, bn: e.blockNumber };
        else if (e.name === "OrderClosed") { const o = ord[String(a.order)]; if (o) o.closed = true; }
        else if (e.name === "Trade") { const f = { market: a.market, maker: ord[String(a.maker)], taker: ord[String(a.taker)], q: f6(a.quantity), x: f6(a.price), bn: e.blockNumber }; fills.push(f); for (const o of [f.maker, f.taker]) if (o) o.filled += f.q; }
        else if (e.name === "Claimed") claims.push({ market: a.market, account: a.account, up: f6(a.up), down: f6(a.down), usdc: f6(a.usdc), imd: f18(a.asset), bn: e.blockNumber });
      }
      IX = { n: ev.n, mk, ord, fills, claims, list: ev.list };
      return IX;
    }
    // USD value of one fill leg for an order (DOWN side pays 1 IMD + (1 - x) USDC per share)
    const legUsd = (o, f, live) => f.q * (isDown(o.action) ? 1 + live - f.x : f.x) * (o.action >= 2 ? -1 : 1);

    // ---- book: walk the linked lists from bestAsk / bestBid (max 40 orders a side), aggregate by price
    function book(C, side, { v, live }) {
      const empty = { asks: [], bids: [], last: null };
      if (!ready()) return empty;
      const id = idOf(C);
      const raw = memo("book:" + id, 10e3, async () => {
        const walk = async head => {
          const lv = new Map(); let o = (await mkt(head, [id]))[0];
          for (let n = 0; o && o !== 0n && n < 40; n++) {
            const [r] = await mkt("order", [o]);
            if (r.resting && Number(r.expiry) * 1e3 > Date.now()) { const x = f6(r.limitPrice); lv.set(x, (lv.get(x) || 0) + f6(r.remaining)); }
            o = r.next;
          }
          return [...lv.entries()];
        };
        return { asks: await walk("bestAsk"), bids: await walk("bestBid") };
      });
      if (!raw) return empty;
      const ix = index(), lf = ix && ix.fills.filter(f => f.market === id).pop(), lastX = lf ? lf.x : null;
      if (side === "UP") return { asks: [...raw.asks].sort((a, b) => b[0] - a[0]), bids: [...raw.bids].sort((a, b) => b[0] - a[0]), last: lastX };
      const toDn = x => (v - x) / (live || 1);                              // mirrored: DOWN price in IMD
      return { asks: raw.bids.map(([p, s]) => [toDn(p), s]).sort((a, b) => b[0] - a[0]), bids: raw.asks.map(([p, s]) => [toDn(p), s]).sort((a, b) => b[0] - a[0]), last: lastX == null ? null : toDn(lastX) };
    }
    function volume(C) { const ix = ready() && index(); if (!ix) return null; const id = idOf(C); return ix.fills.filter(f => f.market === id).reduce((s, f) => s + f.q * f.x, 0); }
    function ladderVolume(k) {
      const ix = index(); if (!ix) return null; const a = ctx.mk(k, 0).a;
      return ix.fills.filter(f => { const m = ix.mk[f.market]; return m && m.k === k && m.a === a && m.K; }).reduce((s, f) => s + f.q * f.x, 0);
    }
    function heroStats() {
      const ix = index(); if (!ix) return { markets: 4, vol24: null, paid: null };
      const from = LOGS.head - 7200, live = ctx.live() || 0;
      return { markets: 4, vol24: ix.fills.filter(f => f.bn >= from).reduce((s, f) => s + f.q * f.x, 0), paid: ix.claims.reduce((s, c) => s + c.usdc + c.imd * live, 0) };
    }

    // ---- balance only: Deposit/Withdraw and the balance line must appear right after Connect without
    // waiting for the full event index (syncLogs can take seconds); this is 2 eth_call + 1 oracle read.
    function balanceOnly(addr) {
      if (!ready() || !addr) return null;
      return memo("bal:" + addr.toLowerCase(), 15e3, async () => {
        const [bu] = await mkt("balance", [addr, cfg.USDC]), [bi] = await mkt("balance", [addr, cfg.IMD]), [cr] = await orc("credit", [addr]);
        return { usdc: f6(bu), imd: f18(bi), credit: f18(cr) };
      });
    }

    // ---- portfolio: balances, positions, open orders, claims, history
    function portfolio(addr, { v, live }) {
      if (!ready() || !addr) return null;
      const ix = index(); if (!ix) return null;
      return memo("pf:" + addr.toLowerCase() + ":" + ix.n, 15e3, async () => {
        const L = live || 0, mine = o => o && same(o.trader, addr), myOrd = Object.values(ix.ord).filter(mine);
        const acct = ix.list.filter(e => same(e.args.account, addr));
        const touched = [...new Set(myOrd.map(o => o.market).concat(acct.map(e => e.args.market)).filter(Boolean))];
        const [bu] = await mkt("balance", [addr, cfg.USDC]), [bi] = await mkt("balance", [addr, cfg.IMD]), [cr] = await orc("credit", [addr]);
        const balance = { usdc: f6(bu), imd: f18(bi) }, credit = f18(cr);
        const positions = [], claims = [];
        for (const id of touched) {
          const m = ix.mk[id]; if (!m) continue;
          const [up, dn] = await mkt("positions", [id, addr]); if (!up && !dn) continue;
          const C = { ...ctx.mk(m.k, 0), ...m, st: m.a > Date.now() ? "next" : m.b <= Date.now() ? "closed" : "live" };
          if (C.st !== "closed") {
            const q = C.K ? null : ctx.qUp(C), fl = ix.fills.filter(f => f.market === id);
            for (const [sd, n] of [["UP", f6(up)], ["DOWN", f6(dn)]]) {
              if (!n) continue;
              const cost = fl.reduce((s, f) => s + [f.maker, f.taker].filter(o => mine(o) && isDown(o.action) === (sd === "DOWN")).reduce((t, o) => t + legUsd(o, f, L), 0), 0);
              positions.push({ ...m, id, sd, n, cost, val: q == null ? n * v / 2 : n * (sd === "UP" ? q : 1 - q) * v });
            }
            continue;
          }
          const [mm] = await mkt("market", [id]); let out = Number(mm.outcome);
          if (!out) { const s = m.K ? { recorded: true, price: m.K } : boundary(m.a), e = boundary(m.b); if (s && e && s.recorded && e.recorded) out = e.price > s.price ? 1 : e.price < s.price ? 2 : 3; }
          const U = f6(up), D = f6(dn);
          if (!out) { claims.push({ ...m, id, sd: U ? "UP" : "DOWN", result: "Resolving · price not recorded", usdc: 0, imd: 0, pending: true }); continue; }
          if (out === 3) claims.push({ ...m, id, sd: U ? "UP" : "DOWN", result: "Refund", usdc: U, imd: D });
          else if (out === 1 && U) claims.push({ ...m, id, sd: "UP", result: "Won", usdc: U, imd: U });
          else if (out === 2 && D) claims.push({ ...m, id, sd: "DOWN", result: "Won", usdc: D, imd: D });
        }
        const orders = [];
        for (const o of myOrd.filter(o => !o.closed)) {
          const [r] = await mkt("order", [o.id]); if (!r.resting) continue;
          const m = ix.mk[o.market] || {}, sd = isDown(o.action) ? "DOWN" : "UP", rem = f6(r.remaining);
          orders.push({ ...m, id: o.id, mid: o.market, action: o.action >= 2 ? "Sell" : "Buy", sd, price: sd === "UP" ? o.x : (v - o.x) / (L || 1), n: o.qty, filled: +(o.qty - rem).toFixed(6), expires: m.b && o.expiry >= m.b ? "market end" : ctx.left(o.expiry) });
        }
        const AN = ["Buy Up", "Buy Down", "Sell Up", "Sell Down"], hist = [];
        for (const e of ix.list) {
          const a = e.args, m = ix.mk[a.market] || {}, base = { time: "~" + timeOf(e.blockNumber), ...m };
          if (e.name === "OrderPlaced" && same(a.trader, addr)) hist.push({ ...base, action: AN[Number(a.action)] + " (order)", n: f6(a.quantity), priceUsd: f6(a.price), feeUsd: 0 });
          else if (e.name === "Trade") for (const o of [ix.ord[String(a.maker)], ix.ord[String(a.taker)]]) { if (mine(o)) hist.push({ ...base, action: AN[o.action] + " · filled", n: f6(a.quantity), priceUsd: f6(a.price), feeUsd: 0 }); }
          else if (same(a.account, addr) && ["Claimed", "Split", "Merged", "Deposited", "Withdrawn"].includes(e.name))
            hist.push({ ...base, k: base.k, action: e.name === "Claimed" ? "Claim" : e.name === "Deposited" ? "Deposit " + (same(a.token, cfg.USDC) ? "USDC" : "IMD") : e.name === "Withdrawn" ? "Withdraw " + (same(a.token, cfg.USDC) ? "USDC" : "IMD") : e.name, n: e.name === "Claimed" ? f6(a.up) + f6(a.down) : a.quantity != null ? f6(a.quantity) : same(a.token, cfg.USDC) ? f6(a.amount) : f18(a.amount), priceUsd: null, feeUsd: 0 });
        }
        const history = hist.slice(-60).reverse();
        const myClaims = ix.claims.filter(c => same(c.account, addr)), cash = t => same(t, cfg.USDC);
        const flow = n => ix.list.filter(e => e.name === n && same(e.args.account, addr)).reduce((s, e) => s + (cash(e.args.token) ? f6(e.args.amount) : f18(e.args.amount) * L), 0);
        const posVal = positions.reduce((s, x) => s + x.val, 0), claimUsd = claims.reduce((s, c) => s + c.usdc + c.imd * L, 0);
        const value = posVal + claimUsd + balance.usdc + (balance.imd + credit) * L + orders.reduce((s, o) => s + (o.n - o.filled) * (o.sd === "UP" ? o.price : o.price * L) * (o.action === "Buy" ? 1 : 0), 0);
        const volume = ix.fills.reduce((s, f) => s + [f.maker, f.taker].filter(mine).length * f.q * f.x, 0);
        // PnL = everything you hold now (USD at the current IMD price) + withdrawn - deposited
        return { value, pnl: value + flow("Withdrawn") - flow("Deposited"), volume, wins: myClaims.filter(c => c.usdc > 0 && c.imd > 0).length, trades: myClaims.length,
          balance, credit, positions, orders, claims, claimUsd, history };
      });
    }

    // ---- leaderboard by trader from fills and claims (cash flow in USD at the current IMD price; open positions not counted)
    function leaderboard(per, mkf) {
      const ix = index(); if (!ix) return null;
      const from = LOGS.head - { day: 7200, week: 50400, month: 216000, all: Infinity }[per], L = ctx.live() || 0, R = {};
      const row = a => R[a.toLowerCase()] || (R[a.toLowerCase()] = { w: a, vol: 0, pnl: 0, tr: 0, won: 0, cl: 0 });
      const okM = id => { if (mkf === "all") return true; const m = ix.mk[id]; return m && m.k === mkf; };
      for (const f of ix.fills) {
        if (f.bn < from || !okM(f.market)) continue;
        for (const o of [f.maker, f.taker]) if (o) { const r = row(o.trader); r.vol += f.q * f.x; r.tr++; r.pnl -= legUsd(o, f, L); }
      }
      for (const c of ix.claims) {
        if (c.bn < from || !okM(c.market)) continue;
        const r = row(c.account); r.pnl += c.usdc + c.imd * L; r.cl++; if (c.usdc > 0 && c.imd > 0) r.won++;
      }
      return Object.values(R).map(r => ({ w: r.w, vol: r.vol, pnl: r.pnl, tr: r.tr, wr: r.cl ? r.won / r.cl : 0 }));
    }

    // ---- writes
    async function order(o) {
      const C = o.C, live = ctx.live(), V = 1 + (live || 0);
      const action = o.side === "UP" ? (o.bs === "BUY" ? ACT.BuyUp : ACT.SellUp) : (o.bs === "BUY" ? ACT.BuyDown : ACT.SellDown);
      const x = o.side === "UP" ? o.price : V - o.price * live;              // page price -> book price (USDC per UP share)
      const x6 = (isBid(action) ? BigInt(Math.floor(x * 1e4 + 1e-9)) : BigInt(Math.ceil(x * 1e4 - 1e-9))) * 100n;   // tick 0.0001
      if (x6 <= 0n) throw Error("Price is out of range");
      const qty6 = u6(o.shares);
      if (qty6 * x6 / 1000000n < 1000000n) throw Error("Minimum order is 1 USDC value");
      const ioc = o.type === "Market", end = BigInt(Math.floor(C.b / 1e3)), now = BigInt(Math.floor(Date.now() / 1e3));
      let expiry = ioc ? 0n : o.expiry === "5m" ? now + 360n : o.expiry === "1h" ? now + 3600n : end;
      if (expiry > end) expiry = end;
      const pr = await proofsFor([...autoBoundaries(), C.a]);                 // midnight, current hour, then this market's start
      const v = await version(), p18 = (await orc("price", [v, (await orc("latestBoundary", [v]))[0]]))[0];
      const cand = [p18, pr.price ? u18(pr.price) : 0n];
      if (!cand.some(Boolean)) throw Error("No IMD price on-chain yet. Trade a market that has started: its start price gets proven.");
      const input = [action, qty6, x6, expiry, ioc, false, 0n, feeBudget(action, x6, qty6, cand), 0n, 32];
      return pr.subs.length ? send("placeWithProofs", [spec(C), input, pr.subs]) : send("place", [spec(C), input]);
    }
    const cancel = ord => send("cancel", [BigInt(ord.id)]);
    async function cancelAll(list) { let h; for (const o of list || []) h = await cancel(o); return h; }
    const split = (C, n) => send("split", [spec(C), u6(n)]);
    const merge = (C, n) => send("merge", [idOf(C), u6(n)]);
    async function claimArgs(c) {
      const id = c.id || idOf(c), [up, dn] = await mkt("positions", [id, W.address]);
      if (!up && !dn) throw Error("Nothing to claim in this market");
      const [m] = await mkt("market", [id]);
      const need = Number(m.outcome) ? [] : [m.ladderStrike ? 0 : Number(m.start) * 1e3, Number(m.end) * 1e3];
      const pr = await proofsFor([...need, ...autoBoundaries()]);             // settlement prices first, then midnight / hour
      return { id, up, dn, subs: pr.subs };
    }
    async function claim(c) {
      if (!W.address) { ctx.connect(); throw Error("Connect a wallet first"); }
      const a = await claimArgs(c);
      return a.subs.length ? send("claimWithProofs", [a.id, a.up, a.dn, a.subs]) : send("claim", [a.id, a.up, a.dn]);
    }
    async function claimAll(list) {
      if (!W.address) { ctx.connect(); throw Error("Connect a wallet first"); }
      const plain = [], proved = [];
      for (const c of list || []) { const a = await claimArgs(c); (a.subs.length ? proved : plain).push(a); }
      let h;
      for (const a of proved) h = await send("claimWithProofs", [a.id, a.up, a.dn, a.subs]);
      for (let i = 0; i < plain.length; i += 64) h = await send("claimAll", [plain.slice(i, i + 64).map(a => a.id)]);
      return h;
    }
    async function deposit(token, amt) {
      if (!W.address) { ctx.connect(); throw Error("Connect a wallet first"); }
      const t = token === "USDC" ? cfg.USDC : cfg.IMD, a = token === "USDC" ? u6(amt) : u18(amt);
      await approveIfNeeded(t, cfg.CONTRACT, a); return send("deposit", [t, a]);
    }
    const withdraw = (token, amt) => send("withdraw", [token === "USDC" ? cfg.USDC : cfg.IMD, token === "USDC" ? u6(amt) : u18(amt)]);
    // optimistic fallback in BoundaryOracle: the 10 IMD bond comes from the wallet (approve to the oracle)
    async function proposePrice(Tms, usd) {
      if (!W.address) { ctx.connect(); throw Error("Connect a wallet first"); }
      const v = await version(), T = Math.floor(Tms / 1e3), firstBlock = await P.blockAt(T);
      await approveIfNeeded(cfg.IMD, (await addrs()).oracle, BOND);
      return sendOracle("propose", [v, BigInt(T), u18(usd), BigInt(firstBlock)]);
    }
    async function dispute(Tms) {
      if (!W.address) { ctx.connect(); throw Error("Connect a wallet first"); }
      const v = await version(), [, total] = await orc("oracleCost", [v]);
      await approveIfNeeded(cfg.IMD, (await addrs()).oracle, BOND + total);
      return sendOracle("dispute", [v, BigInt(Math.floor(Tms / 1e3)), total]);
    }
    const finalize = async Tms => sendOracle("finalize", [await version(), BigInt(Math.floor(Tms / 1e3))]);
    const withdrawCredit = () => sendOracle("withdrawCredit", []);

    return { name: "chain", demo: false, ready, heroStats, volume, ladderVolume, book, portfolio, balance: balanceOnly, leaderboard, boundary,
      order, cancel, cancelAll, split, merge, claim, claimAll, deposit, withdraw, proposePrice, dispute, finalize, withdrawCredit,
      _call: mkt, _events: events, _idOf: idOf, _feeBudget: feeBudget };
  }

  root.PimdApi = { create: (name, ctx) => (name === "chain" ? chainAdapter : demoAdapter)(ctx) };
})(typeof globalThis !== "undefined" ? globalThis : this);
