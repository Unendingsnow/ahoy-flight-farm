// Written by scripts/deploy-live.js. Safe to edit — the site also accepts a
// farm address typed into its network panel (stored per-browser).
window.FARM_CONFIG = {
  "defaultChainId": 369,
  "networks": {
    "369": {
      "name": "PulseChain",
      "rpc": "https://rpc.pulsechain.com",
      "explorer": "https://scan.pulsechain.com",
      "farm": "0x71432b22a63F0f14CA43e00fc269809D3570AC00"
    },
    "943": {
      "name": "Local / PulseChain Testnet v4",
      "rpc": "http://127.0.0.1:8545",
      "explorer": "",
      "farm": ""
    }
  }
};
