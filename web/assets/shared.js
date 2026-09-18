/* NFT Stake Farm — shared wallet / contract / formatting helpers.
 * Used by both index.html (the farm) and admin.html (the control panel).
 * No build step, no framework: plain ES2020 + ethers v6 UMD.
 */
(function () {
  "use strict";

  const E = window.ethers;
  const ZERO = "0x0000000000000000000000000000000000000000";

  const Farm = (window.Farm = {
    ZERO,
    state: {
      provider: null,
      injected: null, // raw EIP-1193 provider of the wallet in use
      wallet: null, // { id, name, icon } of the wallet in use
      signer: null,
      account: null,
      chainId: null,
      farmAddress: null,
      farm: null,
      nft: null,
      nftAddress: null,
      reward: null,
      rewardMeta: null, // { symbol, decimals, name }
      nftMeta: null, // { symbol, name }
      info: null, // last farmInfo()
    },
    listeners: [],
  });

  // ---------------------------------------------------------------- config --

  const LS_FARM = "nftstakefarm.farmAddress";

  function networkConfig(chainId) {
    const cfg = window.FARM_CONFIG || {};
    return (cfg.networks && (cfg.networks[chainId] || cfg.networks[String(chainId)])) || null;
  }

  /** Farm address: ?farm= in the URL wins, then a saved override, then config.js. */
  function resolveFarmAddress(chainId) {
    const qs = new URLSearchParams(location.search).get("farm");
    if (qs && E.isAddress(qs)) return E.getAddress(qs);

    const saved = localStorage.getItem(LS_FARM);
    if (saved && E.isAddress(saved)) return E.getAddress(saved);

    const net = networkConfig(chainId);
    if (net && net.farm && E.isAddress(net.farm)) return E.getAddress(net.farm);
    return null;
  }

  Farm.saveFarmAddress = function (addr) {
    if (addr && E.isAddress(addr)) {
      localStorage.setItem(LS_FARM, E.getAddress(addr));
    } else {
      localStorage.removeItem(LS_FARM);
    }
  };
  Farm.savedFarmAddress = () => localStorage.getItem(LS_FARM) || "";
  Farm.networkConfig = networkConfig;

  /** The chain this farm actually lives on. */
  Farm.defaultChainId = function () {
    const cfg = window.FARM_CONFIG || {};
    const nets = cfg.networks || {};
    const configured = Number(cfg.defaultChainId);
    if (configured && nets[configured] && nets[configured].farm) return configured;
    for (const [id, net] of Object.entries(nets)) {
      if (net && net.farm) return Number(id);
    }
    return configured || null;
  };

  Farm.networkName = function (chainId) {
    const net = networkConfig(chainId);
    return net ? net.name : `Chain ${chainId}`;
  };

  /**
   * Connected, but on a chain this farm does not live on — the single most
   * common reason the whole page reads as empty.
   */
  Farm.wrongNetwork = function () {
    const s = Farm.state;
    if (!s.account || s.farmAddress) return false;
    const target = Farm.defaultChainId();
    return Boolean(target) && target !== s.chainId;
  };

  // ------------------------------------------------------------ formatting --

  Farm.fmt = function (value, decimals = 18, maxFrac = 4) {
    if (value === null || value === undefined) return "—";
    const n = Number(E.formatUnits(value, decimals));
    if (n === 0) return "0";
    if (n > 0 && n < 0.0001) return "<0.0001";
    return n.toLocaleString("en-US", {
      minimumFractionDigits: n < 1 ? Math.min(maxFrac, 4) : 0,
      maximumFractionDigits: maxFrac,
    });
  };

  Farm.fmtCompact = function (value, decimals = 18) {
    const n = Number(E.formatUnits(value ?? 0n, decimals));
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
    return Farm.fmt(value, decimals, 2);
  };

  Farm.shortAddr = (a) => (a && a !== ZERO ? a.slice(0, 6) + "…" + a.slice(-4) : "—");

  Farm.duration = function (seconds) {
    const s = Number(seconds);
    if (!s || s <= 0) return "—";
    const d = Math.floor(s / 86400);
    if (d >= 730) return (d / 365).toFixed(1) + " years";
    if (d >= 2) return d.toLocaleString() + " days";
    const h = Math.floor(s / 3600);
    if (h >= 2) return h + " hours";
    return Math.floor(s / 60) + " min";
  };

  /**
   * Chain time, not browser time. A local node's clock drifts far ahead once
   * you evm_increaseTime, and a user's machine can be skewed either way — both
   * would make every countdown and "is the drip live?" check wrong.
   */
  Farm.now = function () {
    const s = Farm.state;
    if (!s.chainNow) return Math.floor(Date.now() / 1000);
    return s.chainNow + Math.floor((Date.now() - s.chainNowAt) / 1000);
  };

  /** True while the drip is actually streaming, judged on chain time. */
  Farm.dripLive = function (info) {
    return Boolean(info) && info.rewardRate_ > 0n && Number(info.periodFinish_) > Farm.now();
  };

  Farm.countdown = function (targetTs) {
    const left = Number(targetTs) - Farm.now();
    if (left <= 0) return "ended";
    const d = Math.floor(left / 86400);
    const h = Math.floor((left % 86400) / 3600);
    const m = Math.floor((left % 3600) / 60);
    const s = left % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
  };

  Farm.explorerLink = function (addr) {
    const net = networkConfig(Farm.state.chainId);
    if (!net || !net.explorer) return null;
    return `${net.explorer.replace(/\/$/, "")}/address/${addr}`;
  };

  // ---------------------------------------------------------------- toasts --

  let toastHost = null;
  Farm.toast = function (message, kind = "info", ttl = 6000) {
    if (!toastHost) {
      toastHost = document.createElement("div");
      toastHost.className = "toast-host";
      document.body.appendChild(toastHost);
    }
    const el = document.createElement("div");
    el.className = `toast toast--${kind}`;
    el.innerHTML = `<span class="toast__dot"></span><span class="toast__msg"></span>`;
    el.querySelector(".toast__msg").textContent = message;
    toastHost.appendChild(el);

    const kill = () => {
      el.classList.add("toast--out");
      setTimeout(() => el.remove(), 300);
    };
    el.addEventListener("click", kill);
    if (ttl) setTimeout(kill, ttl);
    return kill;
  };

  /** Human-readable reason out of an ethers/provider error. */
  Farm.errorMessage = function (err) {
    if (!err) return "Unknown error";
    if (err.code === 4001 || err.code === "ACTION_REJECTED") return "Rejected in wallet";
    const reason =
      err.reason ||
      err.shortMessage ||
      (err.info && err.info.error && err.info.error.message) ||
      (err.error && err.error.message) ||
      err.message ||
      String(err);
    return String(reason).replace(/^execution reverted:?\s*/i, "").slice(0, 200);
  };

  /** Runs a contract call, toasting pending / mined / failed. Returns receipt or null. */
  Farm.tx = async function (label, sendFn) {
    let dismiss = null;
    try {
      const sent = await sendFn();
      dismiss = Farm.toast(`${label} — confirming…`, "pending", 0);
      const receipt = await sent.wait();
      dismiss();
      Farm.toast(`${label} — done`, "ok");
      await Farm.refresh();
      return receipt;
    } catch (err) {
      if (dismiss) dismiss();
      Farm.toast(`${label} — ${Farm.errorMessage(err)}`, "error", 9000);
      console.error(label, err);
      return null;
    }
  };

  // ---------------------------------------------------------------- wallet --

  /**
   * Wallet discovery.
   *
   * window.ethereum is whichever injected wallet won the race to define it —
   * with two extensions installed the other one is invisible and the user gets
   * silently forced into one of them. EIP-6963 fixes that: every wallet
   * announces itself on an event, so we can list them all and let the user
   * choose. The legacy paths below (window.ethereum.providers, then
   * window.ethereum) cover wallets that have not shipped 6963 yet.
   */

  const LS_WALLET = "nftstakefarm.walletRdns";
  const discovered = new Map(); // rdns/uuid -> { id, name, icon, provider }

  window.addEventListener("eip6963:announceProvider", (ev) => {
    const d = ev.detail;
    if (!d || !d.provider || !d.info) return;
    const id = d.info.rdns || d.info.uuid;
    discovered.set(id, { id, name: d.info.name || id, icon: d.info.icon || "", provider: d.provider });
  });

  function requestAnnouncements() {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  }
  requestAnnouncements();

  /** Best-effort name for a wallet that only injects the old way. */
  function legacyName(p) {
    const flags = [
      ["isRabby", "Rabby"],
      ["isBraveWallet", "Brave Wallet"],
      ["isCoinbaseWallet", "Coinbase Wallet"],
      ["isTrust", "Trust Wallet"],
      ["isTrustWallet", "Trust Wallet"],
      ["isOkxWallet", "OKX Wallet"],
      ["isOKExWallet", "OKX Wallet"],
      ["isPhantom", "Phantom"],
      ["isFrame", "Frame"],
      ["isTaho", "Taho"],
      ["isTally", "Taho"],
      ["isExodus", "Exodus"],
      ["isZerion", "Zerion"],
      ["isBitKeep", "Bitget Wallet"],
      ["isMathWallet", "MathWallet"],
      ["isOpera", "Opera Wallet"],
      ["isXDEFI", "XDEFI"],
      ["isMetaMask", "MetaMask"], // last: plenty of wallets set this flag too
    ];
    for (const [flag, name] of flags) if (p && p[flag]) return name;
    return "Injected wallet";
  }

  /**
   * Every wallet we can see, EIP-6963 first. Re-asks on each call because an
   * extension can finish injecting after page load.
   */
  Farm.wallets = function () {
    requestAnnouncements();
    const out = [...discovered.values()];
    const seen = new Set(out.map((w) => w.provider));

    // window.ethereum.providers means the wallets multiplexed themselves; the
    // window.ethereum on top is just a proxy for one of them, so skip it or it
    // shows up a second time under whatever name it is currently proxying.
    const legacy = [];
    const eth = window.ethereum;
    if (eth) {
      if (Array.isArray(eth.providers) && eth.providers.length) legacy.push(...eth.providers);
      else legacy.push(eth);
    }
    const names = new Set(out.map((w) => w.name.toLowerCase()));
    for (const p of legacy) {
      if (!p || seen.has(p)) continue;
      const name = legacyName(p);
      // A wallet that also announced over 6963 is the same wallet under a
      // different object — one row each, not two.
      if (names.has(name.toLowerCase())) continue;
      seen.add(p);
      names.add(name.toLowerCase());
      out.push({ id: "legacy:" + name, name, icon: "", provider: p, legacy: true });
    }
    return out;
  };

  Farm.hasWallet = () => Farm.wallets().length > 0;

  /** The raw EIP-1193 provider we are connected through. */
  Farm.injected = () => Farm.state.injected || null;

  const NO_WALLET =
    "No wallet found. Install a browser wallet — MetaMask, Rabby, Brave, Coinbase, Trust, " +
    "or any other injected wallet — then reload.";

  // ------------------------------------------------------- wallet chooser --

  let chooserOpen = null;

  /** Modal list of every detected wallet. Resolves with a wallet, or null. */
  function chooseWallet(list) {
    if (chooserOpen) return chooserOpen;
    const last = localStorage.getItem(LS_WALLET);

    chooserOpen = new Promise((resolve) => {
      const back = document.createElement("div");
      back.className = "wallet-modal";
      back.innerHTML =
        `<div class="wallet-modal__box" role="dialog" aria-modal="true" aria-label="Choose a wallet">` +
        `<div class="wallet-modal__head">` +
        `<h3 class="wallet-modal__title">Choose a wallet</h3>` +
        `<button class="wallet-modal__x" type="button" aria-label="Close">×</button>` +
        `</div>` +
        `<div class="wallet-modal__list"></div>` +
        `<p class="wallet-modal__note">Not listed? Unlock the extension, then reload the page.</p>` +
        `</div>`;

      const listEl = back.querySelector(".wallet-modal__list");
      list.forEach((w) => {
        const row = document.createElement("button");
        row.className = "wallet-opt";
        row.type = "button";
        const mark = w.icon
          ? `<img class="wallet-opt__icon" alt="" src="${w.icon}">`
          : `<span class="wallet-opt__icon wallet-opt__icon--blank">${(w.name[0] || "?").toUpperCase()}</span>`;
        row.innerHTML =
          mark +
          `<span class="wallet-opt__name"></span>` +
          (w.id === last ? `<span class="wallet-opt__tag">last used</span>` : "");
        row.querySelector(".wallet-opt__name").textContent = w.name;
        row.addEventListener("click", () => done(w));
        listEl.appendChild(row);
      });

      function done(result) {
        document.removeEventListener("keydown", onKey);
        back.remove();
        chooserOpen = null;
        resolve(result);
      }
      function onKey(ev) {
        if (ev.key === "Escape") done(null);
      }

      back.addEventListener("click", (ev) => {
        if (ev.target === back) done(null);
      });
      back.querySelector(".wallet-modal__x").addEventListener("click", () => done(null));
      document.addEventListener("keydown", onKey);

      document.body.appendChild(back);
      const first = listEl.querySelector(".wallet-opt");
      if (first) first.focus();
    });

    return chooserOpen;
  }

  // ----------------------------------------------------------- connecting --

  let wired = null; // provider we have attached account/chain listeners to
  const reloadPage = () => location.reload();

  function wireEvents(p) {
    if (wired === p) return;
    if (wired && wired.removeListener) {
      wired.removeListener("accountsChanged", reloadPage);
      wired.removeListener("chainChanged", reloadPage);
    }
    if (p && p.on) {
      p.on("accountsChanged", reloadPage);
      p.on("chainChanged", reloadPage);
    }
    wired = p;
  }

  async function connectWith(entry) {
    const provider = new E.BrowserProvider(entry.provider, "any");
    await provider.send("eth_requestAccounts", []);
    const signer = await provider.getSigner();
    const net = await provider.getNetwork();

    Farm.state.provider = provider;
    Farm.state.injected = entry.provider;
    Farm.state.wallet = { id: entry.id, name: entry.name, icon: entry.icon };
    Farm.state.signer = signer;
    Farm.state.account = await signer.getAddress();
    Farm.state.chainId = Number(net.chainId);

    try {
      localStorage.setItem(LS_WALLET, entry.id);
    } catch {
      /* private mode — remembering the choice is a nicety, not a requirement */
    }

    wireEvents(entry.provider);

    // Connecting means connecting to THIS farm's chain. A wallet that opened on
    // Ethereum (or anywhere else) gets asked to move as part of the connect, the
    // way every other dApp does it — not left to figure it out from a notice.
    // Declining is survivable: they stay connected and the notice takes over.
    if (needsNetworkSwitch() && (await Farm.switchToFarm())) return true; // reloading

    await Farm.loadContracts();
    await Farm.refresh();
    return true;
  }

  /**
   * True when the wallet sits on a chain this farm does not live on. A farm
   * address configured (or saved) for the current chain counts as deliberate,
   * so those are left alone.
   */
  function needsNetworkSwitch() {
    const s = Farm.state;
    const target = Farm.defaultChainId();
    if (!target || s.chainId === target) return false;
    return !resolveFarmAddress(s.chainId);
  }

  /**
   * Move the wallet to the farm's chain. The wallet renders its own approve
   * dialog — we cannot switch anyone silently, and should not want to — so hold
   * a toast up while it is open: that popup often lands behind the browser
   * window, and a silent page reads as broken.
   */
  Farm.switchToFarm = async function () {
    const target = Farm.defaultChainId();
    if (!target) return false;
    const name = Farm.networkName(target);
    const dismiss = Farm.toast(`Approve the switch to ${name} in your wallet…`, "pending", 0);
    try {
      await Farm.switchNetwork(target);
      dismiss();
      // chainChanged usually reloads first; not every wallet fires it.
      location.reload();
      return true;
    } catch (err) {
      dismiss();
      Farm.toast(`Still on ${Farm.networkName(Farm.state.chainId)} — ${Farm.errorMessage(err)}`, "error", 9000);
      return false;
    }
  };

  /**
   * Connect on purpose. With more than one wallet installed the user picks —
   * every time, so a wrong pick is never sticky.
   */
  Farm.connect = async function () {
    const list = Farm.wallets();
    if (list.length === 0) {
      Farm.toast(NO_WALLET, "error", 9000);
      return false;
    }
    const entry = list.length === 1 ? list[0] : await chooseWallet(list);
    if (!entry) return false;

    try {
      return await connectWith(entry);
    } catch (err) {
      Farm.toast(Farm.errorMessage(err), "error");
      return false;
    }
  };

  /** Reconnects silently if a wallet is already authorised for this site. */
  Farm.autoConnect = async function () {
    const list = Farm.wallets();
    if (list.length === 0) return false;

    // Prefer the one used last time, then anything already holding an approval.
    let last = null;
    try {
      last = localStorage.getItem(LS_WALLET);
    } catch {
      /* no storage, no preference */
    }
    const ordered = list.slice().sort((a, b) => (b.id === last) - (a.id === last));

    for (const entry of ordered) {
      try {
        const accounts = await entry.provider.request({ method: "eth_accounts" });
        if (!accounts || accounts.length === 0) continue;
        return await connectWith(entry);
      } catch {
        /* locked or unhappy — try the next one */
      }
    }
    return false;
  };

  /** Drops the remembered choice so the next auto-connect starts clean. */
  Farm.forgetWallet = function () {
    try {
      localStorage.removeItem(LS_WALLET);
    } catch {
      /* nothing to forget */
    }
  };

  Farm.switchNetwork = async function (chainId) {
    const eth = Farm.injected();
    if (!eth) throw new Error("No wallet connected");
    const hex = "0x" + Number(chainId).toString(16);
    const net = networkConfig(chainId) || {};
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (err) {
      if (err.code === 4902 || /Unrecognized chain/i.test(err.message || "")) {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: hex,
              chainName: net.name || `Chain ${chainId}`,
              rpcUrls: [net.rpc || "http://127.0.0.1:8545"],
              nativeCurrency: { name: "Pulse", symbol: "PLS", decimals: 18 },
              blockExplorerUrls: net.explorer ? [net.explorer] : undefined,
            },
          ],
        });
      } else {
        throw err;
      }
    }
  };

  // ------------------------------------------------------------- contracts --

  Farm.loadContracts = async function () {
    const s = Farm.state;
    const abi = window.FARM_ABI;
    s.farmAddress = resolveFarmAddress(s.chainId);
    s.farm = s.farmAddress ? new E.Contract(s.farmAddress, abi.farm, s.signer) : null;
    s.nft = null;
    s.nftAddress = null;
    s.reward = null;
    s.rewardMeta = null;
    s.nftMeta = null;
    if (!s.farm) return;

    // Everything else is read off the farm itself, so the site only ever needs
    // one address — swapping the NFT or reward token needs no redeploy here.
    let info;
    try {
      info = await s.farm.farmInfo();
    } catch (err) {
      s.farm = null;
      s.farmError = `No farm contract at ${s.farmAddress} on chain ${s.chainId}.`;
      return;
    }
    s.farmError = null;
    s.info = info;

    if (info.stakingToken_ !== ZERO) {
      s.nft = new E.Contract(info.stakingToken_, abi.nft, s.signer);
      s.nftAddress = info.stakingToken_;
      s.nftMeta = await readTokenMeta(s.nft, { name: "NFT Collection", symbol: "NFT" });
    }
    if (info.rewardsToken_ !== ZERO) {
      s.reward = new E.Contract(info.rewardsToken_, abi.erc20, s.signer);
      s.rewardMeta = await readTokenMeta(s.reward, { name: "Reward", symbol: "RWD", decimals: 18 });
    }
  };

  async function readTokenMeta(contract, fallback) {
    const out = { ...fallback };
    await Promise.all([
      contract.name().then((v) => (out.name = v)).catch(() => {}),
      contract.symbol().then((v) => (out.symbol = v)).catch(() => {}),
      contract.decimals
        ? contract.decimals().then((v) => (out.decimals = Number(v))).catch(() => {})
        : Promise.resolve(),
    ]);
    return out;
  }

  /** Re-reads farmInfo + userInfo and notifies every subscriber. */
  Farm.refresh = async function () {
    const s = Farm.state;
    if (!s.farm) {
      emit();
      return;
    }
    try {
      const block = await s.provider.getBlock("latest");
      if (block) {
        s.chainNow = Number(block.timestamp);
        s.chainNowAt = Date.now();
      }
      s.info = await s.farm.farmInfo();
      s.user = s.account ? await s.farm.userInfo(s.account) : null;
      s.rewardWalletBalance = s.reward && s.account ? await s.reward.balanceOf(s.account) : 0n;
      s.approved =
        s.nft && s.account ? await s.nft.isApprovedForAll(s.account, s.farmAddress).catch(() => false) : false;
    } catch (err) {
      console.error("refresh failed", err);
    }
    emit();
  };

  Farm.onUpdate = (fn) => Farm.listeners.push(fn);
  function emit() {
    for (const fn of Farm.listeners) {
      try {
        fn(Farm.state);
      } catch (err) {
        console.error(err);
      }
    }
  }

  // ------------------------------------------------- NFT ownership discovery --

  /** Canonical Multicall3. Same address on every chain that has it. */
  const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
  const MC3_ABI = [
    "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])",
  ];
  const OWNER_OF = new E.Interface(["function ownerOf(uint256) view returns (address)"]);

  const SWEEP_CHUNK = 1000;
  const SWEEP_CEILING = 20000;
  const SWEEP_TTL_MS = 60_000;

  let sweepCache = null; // { key, at, owners: Map<number,string> }

  /** Drop the cached ownership map — call after any stake/withdraw. */
  Farm.invalidateOwnerSweep = function () {
    sweepCache = null;
  };

  /**
   * Build a full id -> owner map by sweeping `ownerOf` through Multicall3.
   *
   * This is the discovery path for collections that expose no owner
   * enumeration at all — which includes the one this farm points at. It is a
   * plain ERC-721 with no `owned()`/`ownedIds()`/`tokensOfOwner()` and no
   * ERC721Enumerable, so there is simply nothing to ask.
   *
   * The scan is ADAPTIVE because ids are sparse: `totalSupply()` is a COUNT,
   * not a high-water mark. On the live collection it returns 2833 while ids
   * actually run to 3527 — sweeping 1..totalSupply would silently hide ~20% of
   * the collection. So we keep going until every token is accounted for, or the
   * tail is clearly empty, or we hit the ceiling.
   */
  Farm.sweepOwners = async function (onProgress) {
    const s = Farm.state;
    if (!s.nft || !s.provider) return new Map();

    const key = `${s.chainId}:${await s.nft.getAddress()}`;
    if (sweepCache && sweepCache.key === key && Date.now() - sweepCache.at < SWEEP_TTL_MS) {
      return sweepCache.owners;
    }

    const code = await s.provider.getCode(MULTICALL3);
    if (code === "0x") throw new Error("Multicall3 unavailable on this network");

    const nftAddr = await s.nft.getAddress();
    const mc = new E.Contract(MULTICALL3, MC3_ABI, s.provider);

    let expected = 0;
    try {
      expected = Number(await s.nft.totalSupply());
    } catch {
      /* not all collections expose it; the empty-tail rule still terminates */
    }

    const owners = new Map();
    let emptyStreak = 0;

    for (let start = 1; start <= SWEEP_CEILING; start += SWEEP_CHUNK) {
      const calls = [];
      for (let i = start; i < start + SWEEP_CHUNK; i++) {
        calls.push({
          target: nftAddr,
          allowFailure: true,
          callData: OWNER_OF.encodeFunctionData("ownerOf", [i]),
        });
      }

      const res = await mc.aggregate3.staticCall(calls);
      let found = 0;
      res.forEach((r, i) => {
        if (r.success && r.returnData && r.returnData !== "0x") {
          owners.set(start + i, E.getAddress("0x" + r.returnData.slice(26)));
          found++;
        }
      });

      if (onProgress) onProgress(owners.size, expected);
      emptyStreak = found === 0 ? emptyStreak + 1 : 0;

      if (expected && owners.size >= expected) break;
      if (emptyStreak >= 2) break;
    }

    sweepCache = { key, at: Date.now(), owners };
    return owners;
  };

  const TRANSFER_TOPIC = E.id("Transfer(address,address,uint256)");

  /** Keep only the ids `owner` still holds, checked on chain in one batch. */
  Farm.filterOwned = async function (owner, ids) {
    const s = Farm.state;
    if (!ids.length) return [];
    const target = owner.toLowerCase();

    const code = await s.provider.getCode(MULTICALL3).catch(() => "0x");
    if (code !== "0x") {
      const mc = new E.Contract(MULTICALL3, MC3_ABI, s.provider);
      const calls = ids.map((id) => ({
        target: s.nftAddress,
        allowFailure: true,
        callData: OWNER_OF.encodeFunctionData("ownerOf", [id]),
      }));
      const res = await mc.aggregate3.staticCall(calls);
      return ids.filter((id, i) => {
        const r = res[i];
        if (!r.success || !r.returnData || r.returnData === "0x") return false;
        return E.getAddress("0x" + r.returnData.slice(26)).toLowerCase() === target;
      });
    }

    // No Multicall3 on this chain — fall back to individual reads.
    const out = [];
    for (const id of ids) {
      try {
        if ((await s.nft.ownerOf(id)).toLowerCase() === target) out.push(id);
      } catch { /* burned or never minted */ }
    }
    return out;
  };

  /**
   * Discover holdings from Transfer logs.
   *
   * Any token an address owns must have been transferred TO it at some point
   * (a mint is a Transfer from the zero address), so one filtered getLogs call
   * yields every candidate. Cost scales with the WALLET's history rather than
   * the collection's size, which is why this beats sweeping the whole id range:
   * ~0.6s versus ~3-5s on the live collection, and it stays fast on a
   * collection of any size.
   *
   * Candidates are then confirmed with ownerOf, because a token that was
   * received and later sent on still has an inbound Transfer.
   *
   * Returns null when the RPC refuses the query, so the caller can fall back.
   */
  Farm.discoverViaLogs = async function (owner) {
    const s = Farm.state;
    if (!s.nft || !s.provider) return null;

    let logs;
    try {
      logs = await s.provider.getLogs({
        address: s.nftAddress,
        fromBlock: 0,
        toBlock: "latest",
        topics: [TRANSFER_TOPIC, null, E.zeroPadValue(E.getAddress(owner), 32)],
      });
    } catch {
      return null; // many public RPCs cap the block range — caller sweeps instead
    }

    // An ERC-721 Transfer indexes (from, to, tokenId) => 4 topics. An ERC-404
    // emits ERC-20-style Transfers from the SAME address with only 3 topics,
    // where the third field is a value, not a tokenId. Ignore those or we would
    // treat a token amount as an id.
    const ids = [
      ...new Set(
        logs.filter((l) => l.topics.length === 4).map((l) => BigInt(l.topics[3]).toString())
      ),
    ];
    if (!ids.length) return { ids: [], method: "transfer logs" };

    const held = await Farm.filterOwned(owner, ids);
    held.sort((a, b) => Number(a) - Number(b));
    return { ids: held, method: "transfer logs" };
  };

  /**
   * Find the ids `owner` holds.
   *
   * Collections differ wildly, so probe the cheap enumeration shapes first and
   * use whichever answers; fall back to the Multicall3 ownerOf sweep, which
   * works against any ERC-721 whatsoever.
   */
  Farm.discoverOwnedIds = async function (owner, onProgress) {
    const nft = Farm.state.nft;
    if (!nft || !owner) return { ids: [], method: "none" };

    for (const method of ["owned", "ownedIds", "tokensOfOwner"]) {
      try {
        const res = await nft[method](owner);
        if (Array.isArray(res) || (res && typeof res.length === "number")) {
          return { ids: Array.from(res).map((x) => x.toString()), method };
        }
      } catch {
        /* try the next shape */
      }
    }

    // ERC-721 enumerable style, gated on a *plausible* NFT count so we never
    // try to page through an 18-decimal ERC-20 balance.
    for (const balFn of ["erc721BalanceOf", "balanceOf"]) {
      try {
        const raw = await nft[balFn](owner);
        const count = Number(raw);
        if (!Number.isFinite(count) || count <= 0 || count > 5000) continue;
        const ids = [];
        for (let i = 0; i < count; i++) {
          ids.push((await nft.tokenOfOwnerByIndex(owner, i)).toString());
        }
        return { ids, method: `${balFn}+tokenOfOwnerByIndex` };
      } catch {
        /* try the next shape */
      }
    }

    // No native enumeration. Transfer logs are the fast path; the ownerOf sweep
    // is the backstop for RPCs that refuse a wide getLogs range.
    try {
      const viaLogs = await Farm.discoverViaLogs(owner);
      if (viaLogs) return viaLogs;
    } catch (err) {
      console.warn("log discovery failed, sweeping instead", err);
    }

    try {
      const owners = await Farm.sweepOwners(onProgress);
      const target = owner.toLowerCase();
      const ids = [];
      for (const [id, holder] of owners) {
        if (holder.toLowerCase() === target) ids.push(String(id));
      }
      ids.sort((a, b) => Number(a) - Number(b));
      return { ids, method: "ownerOf sweep (Multicall3)" };
    } catch (err) {
      console.error(err);
      return { ids: [], method: "unsupported", error: Farm.errorMessage(err) };
    }
  };

  /** Confirms an id really is owned by `owner` right now. */
  Farm.ownsToken = async function (owner, id) {
    try {
      return (await Farm.state.nft.ownerOf(id)).toLowerCase() === owner.toLowerCase();
    } catch {
      return false;
    }
  };

  // ------------------------------------------------------ artwork / metadata --

  const IPFS_GATEWAY = "https://ipfs.io/ipfs/";
  const metaCache = new Map();

  function ipfsToHttp(uri) {
    if (!uri) return null;
    if (uri.startsWith("ipfs://")) return IPFS_GATEWAY + uri.slice(7).replace(/^ipfs\//, "");
    return uri;
  }

  /** Deterministic panel-badge SVG — the fallback whenever art can't load. */
  Farm.placeholderArt = function (id) {
    const str = String(id);
    // Golden-angle rotation so consecutive ids land far apart on the wheel —
    // a plain string hash gives ids 1..9 nearly identical colours.
    let seed = Number(str);
    if (!Number.isFinite(seed)) {
      seed = 0;
      for (let i = 0; i < str.length; i++) seed = (seed * 31 + str.charCodeAt(i)) >>> 0;
    }
    const hue = Math.round((seed * 137.508) % 360);
    const hue2 = (hue + 42) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
<defs>
  <linearGradient id="g" x1="0" y1="0" x2="0.7" y2="1">
    <stop offset="0" stop-color="hsl(${hue},52%,24%)"/>
    <stop offset="1" stop-color="hsl(${hue2},60%,9%)"/>
  </linearGradient>
</defs>
<rect width="300" height="300" fill="url(#g)"/>
<circle cx="150" cy="150" r="104" fill="none" stroke="hsl(${hue},85%,72%)" stroke-opacity=".2" stroke-width="1.4"/>
<circle cx="150" cy="150" r="72" fill="none" stroke="hsl(${hue},85%,72%)" stroke-opacity=".13" stroke-width="1.4"/>
<path d="M150 62 L226 106 L226 194 L150 238 L74 194 L74 106 Z"
      fill="hsl(${hue},90%,76%)" fill-opacity=".95"/>
<path d="M150 104 L190 127 L190 173 L150 196 L110 173 L110 127 Z"
      fill="hsl(${hue2},60%,9%)" fill-opacity=".55"/>
</svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  };

  /**
   * Best-effort art lookup: tokenURI -> metadata JSON -> image. Any failure
   * (no gateway, dead host, CORS, local mock URI) falls back to the badge.
   */
  /**
   * Thumbnail proxy. The live collection's PNGs are 300KB–1MB each, which is far
   * too heavy for a grid, so full-size art is only ever a fallback.
   * Degrades safely: if the proxy is unreachable the card falls back to the
   * original URL, then to the generated badge.
   */
  Farm.thumb = function (url, w = 320) {
    if (!url || url.startsWith("data:")) return url;
    return "https://wsrv.nl/?url=" + encodeURIComponent(url) + "&w=" + w + "&output=webp&q=78";
  };

  /**
   * Most collections serve art at a path derivable from tokenURI, e.g.
   *   .../metadata/1890.json  ->  .../images/1890.png
   *
   * Where that holds we can render every card with ZERO extra RPC calls and ZERO
   * metadata fetches: probe the shape ONCE against a single token, then template
   * the rest. That is the difference between one request and two-per-NFT, and it
   * is what makes a wallet full of NFTs appear instantly instead of trickling in.
   *
   * undefined = not probed yet, null = no usable template (fall back per token).
   */
  let artTemplate;

  function loadsAsImage(url, timeoutMs = 9000) {
    return new Promise((resolve) => {
      const img = new Image();
      let done = false;
      const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
      const timer = setTimeout(() => finish(false), timeoutMs);
      img.onload = () => { clearTimeout(timer); finish(true); };
      img.onerror = () => { clearTimeout(timer); finish(false); };
      img.src = url;
    });
  }

  /** Builds candidate image URLs from a tokenURI that embeds the id. */
  function templateFrom(uri, id) {
    const out = [];
    const sid = String(id);
    // .../metadata/<id>.json -> .../images/<id>.<ext>
    if (uri.includes("/metadata/")) {
      for (const ext of ["png", "jpg", "jpeg", "webp", "gif"]) {
        out.push(uri.replace("/metadata/", "/images/").replace(/.json$/i, "." + ext));
      }
    }
    // .../<id>.json -> .../<id>.<ext>  (same directory)
    if (/.json$/i.test(uri)) {
      for (const ext of ["png", "jpg", "webp"]) out.push(uri.replace(/.json$/i, "." + ext));
    }
    return out.filter((u) => u.includes(sid));
  }

  Farm.resolveArtTemplate = async function (sampleId) {
    if (artTemplate !== undefined) return artTemplate;
    artTemplate = null;
    const nft = Farm.state.nft;
    if (!nft || sampleId === undefined) return artTemplate;

    try {
      const uri = ipfsToHttp(await nft.tokenURI(sampleId));
      if (!uri || uri.startsWith("data:")) return artTemplate;

      for (const candidate of templateFrom(uri, sampleId)) {
        if (await loadsAsImage(Farm.thumb(candidate))) {
          // Store the shape with the id replaced by a placeholder token.
          artTemplate = candidate.split(String(sampleId)).join("{id}");
          break;
        }
      }
    } catch {
      /* leave null — per-token metadata still works */
    }
    return artTemplate;
  };

  /** Image URL for an id straight from the template, or null. */
  Farm.templatedArt = function (id) {
    if (!artTemplate) return null;
    return artTemplate.split("{id}").join(String(id));
  };

  /**
   * Resolve art for one token. Order: template (free) -> metadata fetch ->
   * generated badge. Always returns something renderable.
   */
  Farm.tokenArt = async function (id) {
    if (metaCache.has(id)) return metaCache.get(id);

    const fallback = { image: Farm.placeholderArt(id), name: `#${id}`, generated: true };

    const templated = Farm.templatedArt(id);
    if (templated) {
      const hit = { image: templated, name: `#${id}`, generated: false };
      metaCache.set(id, hit);
      return hit;
    }

    metaCache.set(id, fallback);
    const nft = Farm.state.nft;
    if (!nft) return fallback;

    try {
      const uri = ipfsToHttp(await nft.tokenURI(id));
      if (!uri) return fallback;

      let meta;
      if (uri.startsWith("data:application/json")) {
        const payload = uri.slice(uri.indexOf(",") + 1);
        meta = JSON.parse(uri.includes(";base64,") ? atob(payload) : decodeURIComponent(payload));
      } else {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 7000);
        const res = await fetch(uri, { signal: ctl.signal });
        clearTimeout(timer);
        if (!res.ok) return fallback;
        meta = await res.json();
      }

      const image = ipfsToHttp(meta.image || meta.image_url);
      if (!image) return fallback;
      const resolved = { image, name: meta.name || `#${id}`, generated: false };
      metaCache.set(id, resolved);
      return resolved;
    } catch {
      return fallback;
    }
  };

})();
