/* (p)IMD · wallet.js — the wallet module. The rest of the site talks to globalThis.WALLET only.

   Login: browser wallets only, connected directly via EIP-6963 (MetaMask, Rabby, Coinbase, OKX, Rainbow, Trust and any
   other installed one).

   INTERFACE used by the site:
     address            string | null      connected account
     chainId            number | null      current chain of the wallet
     chainOk            boolean            chainId === CONFIG.CHAIN_ID
     list()             wallets for the Connect window [{id,name,emoji,color,icon,installed,note}]
     connect(id)        Promise<address>   connect the picked wallet (not installed: opens its install page)
     ensureChain()      Promise            switch the wallet to CONFIG.CHAIN_ID
     sendTx({to,data,value?})  Promise<txHash>   send from `address` on CONFIG.CHAIN_ID (switches chain first)
     signTypedData(typedData)  Promise<signature> EIP-712 (eth_signTypedData_v4)
     disconnect()  restore()  onChange(fn)  short(addr) */
(function (root) {
  "use strict";
  const C = root.CONFIG || {}, CHAIN_NUM = C.CHAIN_ID || 1, CHAIN = "0x" + CHAIN_NUM.toString(16);
  // the most popular wallets, always on top in this order; id = EIP-6963 rdns
  const KNOWN = [
    { id: "io.metamask", name: "MetaMask", emoji: "🦊", color: "#f6851b", url: "https://metamask.io/download/" },
    { id: "io.rabby", name: "Rabby", emoji: "🐰", color: "#7084ff", url: "https://rabby.io/" },
    { id: "com.coinbase.wallet", name: "Coinbase Wallet", emoji: "🔵", color: "#0052ff", url: "https://www.coinbase.com/wallet/downloads" },
    { id: "com.okex.wallet", name: "OKX Wallet", emoji: "⬛", color: "#111", url: "https://www.okx.com/web3" },
    { id: "me.rainbow", name: "Rainbow", emoji: "🌈", color: "#ff6b3d", url: "https://rainbow.me/download" },
    { id: "com.trustwallet.app", name: "Trust Wallet", emoji: "🛡️", color: "#3375bb", url: "https://trustwallet.com/download" },
  ];
  const found = new Map();   // rdns -> {info, provider}
  const subs = [];
  let provider = null;
  const W = {
    address: null, chainId: null,
    get chainOk() { return this.chainId === CHAIN_NUM; },
    onChange: f => subs.push(f),
    short: a => a ? a.slice(0, 6) + "…" + a.slice(-4) : "",
  };
  const emit = () => subs.forEach(f => { try { f(W); } catch (e) { } });
  const setChain = id => { W.chainId = id == null ? null : parseInt(id, 16); };

  if (typeof window !== "undefined") {
    window.addEventListener("eip6963:announceProvider", e => {
      const d = e.detail; if (!d || !d.info || !d.provider) return;
      found.set(d.info.rdns || d.info.uuid, d); emit();
    });
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  }
  // legacy injected provider when nothing announced itself
  function legacy() {
    const eth = typeof window !== "undefined" && window.ethereum; if (!eth || found.size) return;
    const id = eth.isRabby ? "io.rabby" : eth.isMetaMask ? "io.metamask" : eth.isCoinbaseWallet ? "com.coinbase.wallet" : "injected";
    found.set(id, { info: { rdns: id, name: "Browser wallet", uuid: id }, provider: eth });
  }

  // popular first (installed or "Install"), then every other installed wallet
  W.list = function () {
    legacy();
    const out = KNOWN.map(k => { const f = found.get(k.id); return { ...k, installed: !!f, icon: f && f.info.icon, note: f ? "Installed" : "Install" }; });
    for (const [id, f] of found) if (!KNOWN.some(k => k.id === id))
      out.push({ id, name: f.info.name, emoji: "👛", color: "#444", icon: f.info.icon, installed: true, note: "Installed" });
    return out;
  };

  function bind(f) {
    const p = f.provider; provider = p;
    if (p.on && !p.__pimd) {
      p.__pimd = 1;
      p.on("accountsChanged", a => { if (provider !== p) return; W.address = a && a[0] ? a[0] : null; if (!W.address) localStorage.removeItem("pimd-wallet"); emit(); });
      p.on("chainChanged", id => { if (provider !== p) return; setChain(id); emit(); });
    }
  }
  const need = () => { if (!provider || !W.address) throw Error("Connect a wallet first"); return provider; };

  W.ensureChain = async function () {
    const p = need();
    setChain(await p.request({ method: "eth_chainId" }));
    if (W.chainOk) return true;
    try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN }] }); setChain(CHAIN); }
    catch (e) { throw Error("Switch your wallet to Ethereum mainnet"); }
    finally { emit(); }
    return true;
  };
  W.connect = async function (id) {
    legacy();
    if (!id) id = [...found.keys()][0];
    const k = KNOWN.find(x => x.id === id), f = found.get(id);
    if (!f) { if (k && k.url) window.open(k.url, "_blank", "noopener"); throw Error((k ? k.name : "A browser wallet") + " is not installed"); }
    bind(f);
    const a = await f.provider.request({ method: "eth_requestAccounts" });
    W.address = a[0] || null;
    localStorage.setItem("pimd-wallet", id);
    try { await W.ensureChain(); } finally { emit(); }
    return W.address;
  };
  W.restore = async function () {
    const id = localStorage.getItem("pimd-wallet"); if (!id) return;
    await new Promise(r => setTimeout(r, 300)); legacy();
    const f = found.get(id); if (!f) return;
    try {
      bind(f);
      const a = await f.provider.request({ method: "eth_accounts" });
      W.address = a[0] || null;
      setChain(await f.provider.request({ method: "eth_chainId" }));
      emit();
    } catch (e) { }
  };
  W.disconnect = function () { W.address = null; W.chainId = null; provider = null; localStorage.removeItem("pimd-wallet"); emit(); };
  W.sendTx = async function (tx) {
    const p = need(); await W.ensureChain();
    const t = { from: W.address, to: tx.to, data: tx.data };
    if (tx.value) t.value = "0x" + BigInt(tx.value).toString(16);
    return p.request({ method: "eth_sendTransaction", params: [t] });
  };
  W.signTypedData = async function (typed) {
    const p = need(); await W.ensureChain();
    const json = JSON.stringify(typed, (k, v) => typeof v === "bigint" ? v.toString() : v);
    return p.request({ method: "eth_signTypedData_v4", params: [W.address, json] });
  };

  root.WALLET = W;
})(typeof globalThis !== "undefined" ? globalThis : this);
