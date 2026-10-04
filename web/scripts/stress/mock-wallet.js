// A scriptable injected wallet for the hostile local chain. Forwards to the
// node's unlocked accounts; window.__wallet controls misbehaviour.
(() => {
  const RPC = "http://127.0.0.1:8545";
  const listeners = {};
  const W = window.__wallet = {
    account: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // hardhat #1
    chainId: 31337,
    connected: false,
    reject: false,        // reject the next signing request(s) with 4001
    rejectConnect: false,
    rejectSwitch: false,
    hang: false,          // never answer signing requests
    sent: [],             // methods seen
    txs: [],
    emit(ev, data) { (listeners[ev] || []).forEach((f) => { try { f(data); } catch {} }); },
    setAccount(a) { this.account = a; this.emit("accountsChanged", a ? [a] : []); },
    setChain(id) { this.chainId = id; this.emit("chainChanged", "0x" + id.toString(16)); },
  };
  let nextId = 1;
  const rpc = async (method, params) => {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: params ?? [] }) });
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.message); e.code = j.error.code ?? -32603; e.data = j.error.data; throw e; }
    return j.result;
  };
  const userReject = () => { const e = new Error("User rejected the request."); e.code = 4001; return e; };
  const SIGN = new Set(["eth_sendTransaction", "personal_sign", "eth_sign", "eth_signTypedData_v4", "eth_signTypedData"]);
  const provider = {
    isMetaMask: false,
    async request({ method, params }) {
      W.sent.push(method);
      switch (method) {
        case "eth_requestAccounts":
          if (W.rejectConnect) throw userReject();
          W.connected = true; return W.account ? [W.account] : [];
        case "eth_accounts": return W.connected && W.account ? [W.account] : [];
        case "eth_chainId": return "0x" + W.chainId.toString(16);
        case "net_version": return String(W.chainId);
        case "wallet_switchEthereumChain": {
          if (W.rejectSwitch) throw userReject();
          const id = parseInt(params[0].chainId, 16);
          if (id !== 31337) { const e = new Error("Unrecognized chain"); e.code = 4902; throw e; }
          W.setChain(id); return null;
        }
        case "wallet_addEthereumChain": return null;
        case "wallet_requestPermissions": return [{ parentCapability: "eth_accounts" }];
        case "wallet_getPermissions": return W.connected ? [{ parentCapability: "eth_accounts" }] : [];
        case "wallet_revokePermissions": W.connected = false; return null;
        case "wallet_getCapabilities": case "wallet_sendCalls": case "wallet_getCallsStatus": {
          const e = new Error("Method not supported"); e.code = 4200; throw e;
        }
      }
      if (SIGN.has(method)) {
        if (W.hang) return new Promise(() => {});
        if (W.reject) throw userReject();
        if (W.chainId !== 31337 && method === "eth_sendTransaction") { const e = new Error("wallet is on another chain"); e.code = -32603; throw e; }
        if (method === "eth_sendTransaction") {
          const tx = { ...params[0] };
          if (W.forceGas) tx.gas = W.forceGas; // skip the node's own estimate, so a failing tx still gets mined
          const h = await rpc("eth_sendTransaction", [tx]);
          W.txs.push(h); return h;
        }
        return rpc(method, params);
      }
      return rpc(method, params);
    },
    on(ev, f) { (listeners[ev] = listeners[ev] || []).push(f); return provider; },
    removeListener(ev, f) { listeners[ev] = (listeners[ev] || []).filter((x) => x !== f); return provider; },
  };
  window.ethereum = provider;
  const info = { uuid: "7b0b8f0e-0000-4000-8000-000000000001", name: "Mock Wallet", icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIvPg==", rdns: "fun.doubleplus.mockwallet" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();
// Record every toast the user sees.
(() => {
  window.__toasts = [];
  const seen = new WeakSet();
  const start = () => new MutationObserver(() => {
    document.querySelectorAll('[role="status"]').forEach((el) => {
      if (seen.has(el)) return; seen.add(el);
      setTimeout(() => window.__toasts.push(el.innerText.replace(/\s+/g, " ").trim()), 50);
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.documentElement) start(); else document.addEventListener("DOMContentLoaded", start);
})();
// Front-running: before the user's tx goes out, another account sends the
// same call with more ETH, so the price moves between quote and inclusion.
(() => {
  const W = window.__wallet;
  const orig = window.ethereum.request;
  window.ethereum.request = async (a) => {
    if (a.method === "eth_sendTransaction" && W.frontrun && !W.reject && !W.hang) {
      const tx = a.params[0];
      await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9e6, method: "eth_sendTransaction", params: [{ ...tx, from: "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720", value: W.frontrun, gas: "0x1E8480" }] }) });
      W.frontrun = null;
    }
    return orig.call(window.ethereum, a);
  };
})();
