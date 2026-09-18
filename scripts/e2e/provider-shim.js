// An EIP-1193 provider for driving the real app against a local anvil fork from an automated
// browser that has no wallet. Anvil's default accounts are unlocked, so eth_sendTransaction
// needs no signing: the "wallet" is a JSON-RPC proxy plus an account list, announced over
// EIP-6963 so wagmi's injected connector finds it exactly as it would find MetaMask.
(() => {
  const RPC = "http://127.0.0.1:8545";
  const ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // anvil #1 ("alice")
  const CHAIN_ID = "0x1237"; // 4663
  const listeners = {};
  let id = 1;
  async function rpc(method, params) {
    const res = await fetch(RPC, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params: params ?? [] }),
    });
    const json = await res.json();
    if (json.error) { const e = new Error(json.error.message); e.code = json.error.code; e.data = json.error.data; throw e; }
    return json.result;
  }
  const provider = {
    isShim: true,
    isMetaMask: true,
    async request({ method, params }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts": return [ACCOUNT];
        case "eth_chainId": return CHAIN_ID;
        case "net_version": return "4663";
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain": return null;
        case "wallet_requestPermissions": return [{ parentCapability: "eth_accounts" }];
        case "wallet_getPermissions": return [{ parentCapability: "eth_accounts" }];
        case "eth_sendTransaction": {
          const tx = { ...params[0], from: ACCOUNT };
          delete tx.gas; // let anvil estimate
          return rpc("eth_sendTransaction", [tx]);
        }
        case "personal_sign":
        case "eth_signTypedData_v4": throw Object.assign(new Error("shim does not sign messages"), { code: 4200 });
        default: return rpc(method, params);
      }
    },
    on(event, fn) { (listeners[event] ??= []).push(fn); return provider; },
    removeListener(event, fn) { listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn); return provider; },
  };
  window.ethereum = provider;
  const detail = Object.freeze({
    info: { uuid: "6d1f0b2a-shim-anvil", name: "Anvil Shim", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "local.anvil.shim" },
    provider,
  });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
  console.log("[shim] provider installed for", ACCOUNT);
})();
