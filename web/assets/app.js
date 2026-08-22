/* NFT Stake Farm — the staker-facing app. */
(function () {
  "use strict";

  const A = window.Farm;
  const E = window.ethers;
  const $ = (id) => document.getElementById(id);

  const ui = {
    freeIds: [],       // owned, not staked
    stakedIds: [],     // held by the farm for this wallet
    selFree: new Set(),
    selStaked: new Set(),
    discoverMethod: null,
    discoverError: null,
    loadingApes: false,
    sweepProgress: null, // { done, total } while an ownerOf sweep is running
    // live-tick basis
    earnedBase: 0n,
    perSecond: 0n,
    tickFrom: Date.now(),
  };

  // ------------------------------------------------------------- notices --

  function notice(html, kind = "warn") {
    const el = document.createElement("div");
    el.className = "notice" + (kind === "error" ? " notice--error" : "");
    el.innerHTML = `<span class="notice__icon">${kind === "error" ? "⚠" : "✈"}</span><div>${html}</div>`;
    return el;
  }

  function renderNotices() {
    const host = $("notices");
    host.innerHTML = "";
    const s = A.state;

    if (!A.hasWallet()) {
      host.appendChild(
        notice(
          "<strong>No wallet detected.</strong> Install MetaMask (or any injected wallet) and reload to stake. " +
            "You can still read the farm's numbers below once an address is configured.",
          "error"
        )
      );
      return;
    }
    if (!s.account) {
      host.appendChild(notice("<strong>Wallet not connected.</strong> Connect to see your NFTs and rewards."));
      return;
    }
    if (s.farmError) {
      host.appendChild(notice(`<strong>${s.farmError}</strong> Use “Change farm address” below to point at the right one.`, "error"));
      return;
    }
    if (!s.farmAddress) {
      host.appendChild(
        notice(
          `<strong>No farm configured for chain ${s.chainId}.</strong> ` +
            `Deploy one (<code>npm run deploy:local</code>) or set the address with “Change farm address”.`,
          "error"
        )
      );
      return;
    }
    if (!s.info) return;

    if (s.info.stakingToken_ === A.ZERO || s.info.rewardsToken_ === A.ZERO) {
      host.appendChild(
        notice(
          "<strong>The farm isn't wired up yet.</strong> The owner still has to set the " +
            (s.info.stakingToken_ === A.ZERO ? "NFT collection" : "") +
            (s.info.stakingToken_ === A.ZERO && s.info.rewardsToken_ === A.ZERO ? " and the " : "") +
            (s.info.rewardsToken_ === A.ZERO ? "reward token" : "") +
            ". Staking is closed until then."
        )
      );
      return;
    }
    if (s.info.paused_) {
      host.appendChild(
        notice("<strong>New stakes are paused.</strong> Withdrawing and claiming stay open — your NFTs are never locked in.")
      );
    }
    if (!A.dripLive(s.info)) {
      host.appendChild(
        notice("<strong>No drip is running right now.</strong> Staked NFTs accrue nothing until the owner starts the next window.")
      );
    }
    if (ui.discoverMethod === "unsupported" && ui.stakedIds.length === 0) {
      host.appendChild(
        notice(
          "<strong>Couldn't list your NFTs automatically.</strong> This collection doesn't expose a " +
            "wallet-enumeration method the site recognises. Your staked NFTs are still shown, and staking by " +
            "ID still works from a block explorer.",
          "error"
        )
      );
    }
  }

  // ----------------------------------------------------------- farm stats --

  function rewardSymbol() {
    return (A.state.rewardMeta && A.state.rewardMeta.symbol) || "—";
  }
  function rewardDecimals() {
    return (A.state.rewardMeta && A.state.rewardMeta.decimals) || 18;
  }

  function renderStats() {
    const s = A.state;
    const info = s.info;
    const dec = rewardDecimals();
    const sym = rewardSymbol();

    $("aFarm").textContent = s.farmAddress || "not configured";
    if (!info) return;

    const totalStaked = info.totalStaked_;
    const perDay = info.rewardRate_ * 86400n;
    const live = A.dripLive(info);

    $("sTotalStaked").textContent = totalStaked.toString();
    $("sStakers").textContent =
      info.stakerCount_ === 1n ? "1 pilot on the roster" : `${info.stakerCount_} pilots on the roster`;

    $("sPerDay").firstChild.nodeValue = live ? A.fmtCompact(perDay, dec) : "0";
    $("sPerDayUnit").textContent = sym;
    $("sPerApeDay").textContent =
      !live
        ? "no active drip"
        : totalStaked > 0n
        ? `${A.fmt(perDay / totalStaked, dec, 4)} ${sym} per NFT / day`
        : `${A.fmt(perDay, dec, 4)} ${sym} to the first NFT staked`;

    $("sReserve").firstChild.nodeValue = A.fmtCompact(info.rewardBalance_, dec);
    $("sReserveUnit").textContent = sym;
    $("sOwed").textContent = `${A.fmt(info.outstanding_, dec, 2)} ${sym} already earned by stakers`;

    $("sRemaining").textContent = live ? A.countdown(info.periodFinish_) : "—";
    $("sDuration").textContent = `window: ${A.duration(info.rewardsDuration_)}`;

    // drip schedule
    const mine = s.user ? BigInt(s.user.staked.length) : 0n;
    $("fYourStake").textContent = `${mine} / ${totalStaked}`;
    const sharePct = totalStaked > 0n ? (Number(mine) / Number(totalStaked)) * 100 : 0;
    $("fYourShare").textContent = totalStaked > 0n ? sharePct.toFixed(2) + "%" : "—";
    $("rShareBar").style.width = Math.min(100, sharePct) + "%";

    const mineDay = s.user ? s.user.perSecond * 86400n : 0n;
    $("fYourDay").textContent = `${A.fmt(mineDay, dec, 4)} ${sym}`;
    $("fWalletBal").textContent = `${A.fmt(s.rewardWalletBalance ?? 0n, dec, 4)} ${sym}`;

    $("fRewardToken").textContent = s.rewardMeta ? `${s.rewardMeta.symbol} · ${A.shortAddr(info.rewardsToken_)}` : "—";
    $("fNftToken").textContent = s.nftMeta ? `${s.nftMeta.symbol} · ${A.shortAddr(info.stakingToken_)}` : "—";
    $("fEnds").textContent = live ? new Date(Number(info.periodFinish_) * 1000).toLocaleDateString() : "—";

    $("aNft").textContent = info.stakingToken_ === A.ZERO ? "not set" : info.stakingToken_;
    $("aReward").textContent = info.rewardsToken_ === A.ZERO ? "not set" : info.rewardsToken_;

    // reward panel
    $("rSymbol").textContent = sym;
    ui.earnedBase = s.user ? s.user.earned_ : 0n;
    ui.perSecond = s.user ? s.user.perSecond : 0n;
    ui.tickFrom = Date.now();
    tickEarned();

    $("rRate").textContent = !s.account
      ? "Connect a wallet to see your stream."
      : mine === 0n
      ? "Stake an NFT to open your stream."
      : ui.perSecond > 0n
      ? `Streaming ${A.fmt(ui.perSecond * 3600n, dec, 4)} ${sym} / hour to you right now.`
      : "Your NFTs are staked, but no drip is running.";

    $("claimBtn").disabled = !s.account || ui.earnedBase === 0n;
    $("exitBtn").disabled = !s.account || (mine === 0n && ui.earnedBase === 0n);
  }

  function tickEarned() {
    const dec = rewardDecimals();
    const elapsedMs = BigInt(Math.max(0, Date.now() - ui.tickFrom));
    const accrued = (ui.perSecond * elapsedMs) / 1000n;
    const total = ui.earnedBase + accrued;
    $("rEarned").textContent = A.fmt(total, dec, ui.perSecond > 0n ? 6 : 4);
  }

  // -------------------------------------------------------------- network --

  function renderNetwork() {
    const s = A.state;
    const pill = $("netPill");
    if (!s.account) {
      pill.classList.add("hidden");
      return;
    }
    pill.classList.remove("hidden");
    const net = A.networkConfig(s.chainId);
    const ok = Boolean(s.farmAddress) && !s.farmError;
    pill.className = "pill " + (ok ? "pill--ok" : "pill--warn");
    $("netName").textContent = `${net ? net.name : "Chain " + s.chainId} · ${A.shortAddr(s.account)}`;

    const btn = $("connectBtn");
    btn.textContent = A.shortAddr(s.account);
    btn.classList.remove("btn--primary");
    $("heroConnect").textContent = "Jump to the vault";
  }

  // --------------------------------------------------------------- vault --

  function nftCard(id, selected, onToggle) {
    const el = document.createElement("button");
    el.className = "nft";
    el.type = "button";
    el.setAttribute("aria-pressed", selected ? "true" : "false");
    el.innerHTML =
      `<img class="nft__img" alt="NFT #${id}" src="${A.placeholderArt(id)}" loading="lazy">` +
      `<span class="nft__tick">✓</span>` +
      `<span class="nft__id">#${id}</span>`;
    el.addEventListener("click", () => onToggle(id, el));
    return el;
  }

  /** Fills in real artwork behind the placeholders, a few at a time. */
  async function hydrateArt(entries) {
    const queue = entries.slice();
    const worker = async () => {
      while (queue.length) {
        const { id, el } = queue.shift();
        const art = await A.tokenArt(id);
        if (!art.generated && el.isConnected) {
          const img = el.querySelector("img");
          const probe = new Image();
          probe.onload = () => { img.src = art.image; };
          probe.src = art.image;
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  function renderHangar() {
    const s = A.state;
    const freeGrid = $("freeGrid");
    const stakedGrid = $("stakedGrid");
    freeGrid.innerHTML = "";
    stakedGrid.innerHTML = "";

    if (!s.account || !s.nft) {
      freeGrid.appendChild(emptyBox("Connect your wallet to see your NFTs."));
      stakedGrid.appendChild(emptyBox("Nothing staked."));
      updateHangarButtons();
      return;
    }

    if (ui.loadingApes) {
      if (ui.sweepProgress) {
        const { done, total } = ui.sweepProgress;
        freeGrid.appendChild(
          emptyBox(
            total
              ? `Scanning the collection… ${done} / ${total} tokens`
              : `Scanning the collection… ${done} tokens`
          )
        );
      } else {
        for (let i = 0; i < 6; i++) {
          const sk = document.createElement("div");
          sk.className = "skeleton";
          freeGrid.appendChild(sk);
        }
      }
    } else if (ui.freeIds.length === 0) {
      freeGrid.appendChild(
        emptyBox(
          ui.discoverMethod === "unsupported"
            ? `Couldn't read this wallet's NFTs.${ui.discoverError ? " " + ui.discoverError : ""}`
            : "No unstaked NFTs in this wallet."
        )
      );
    } else {
      const entries = [];
      for (const id of ui.freeIds) {
        const el = nftCard(id, ui.selFree.has(id), (tid, node) => toggle(ui.selFree, tid, node));
        freeGrid.appendChild(el);
        entries.push({ id, el });
      }
      hydrateArt(entries);
    }

    if (ui.stakedIds.length === 0) {
      stakedGrid.appendChild(emptyBox("No NFTs staked yet. Select some on the left and stake."));
    } else {
      const entries = [];
      for (const id of ui.stakedIds) {
        const el = nftCard(id, ui.selStaked.has(id), (tid, node) => toggle(ui.selStaked, tid, node));
        stakedGrid.appendChild(el);
        entries.push({ id, el });
      }
      hydrateArt(entries);
    }

    $("freeCount").textContent = ui.freeIds.length;
    $("stakedCount").textContent = ui.stakedIds.length;
    updateHangarButtons();
  }

  function emptyBox(text) {
    const el = document.createElement("div");
    el.className = "empty";
    el.style.gridColumn = "1 / -1";
    el.textContent = text;
    return el;
  }

  function toggle(set, id, el) {
    if (set.has(id)) set.delete(id);
    else set.add(id);
    el.setAttribute("aria-pressed", set.has(id) ? "true" : "false");
    updateHangarButtons();
  }

  function updateHangarButtons() {
    const s = A.state;
    const canAct = Boolean(s.account && s.farm && s.nft);
    const approved = Boolean(s.approved);
    const paused = Boolean(s.info && s.info.paused_);

    $("approveBtn").hidden = !canAct || approved;
    $("stakeBtn").disabled = !canAct || !approved || paused || ui.selFree.size === 0;
    $("stakeBtn").textContent = paused
      ? "Staking paused"
      : ui.selFree.size > 0
      ? `Stake ${ui.selFree.size} NFT${ui.selFree.size > 1 ? "s" : ""}`
      : "Stake selected";

    $("withdrawBtn").disabled = !canAct || ui.selStaked.size === 0;
    $("withdrawBtn").textContent =
      ui.selStaked.size > 0
        ? `Withdraw ${ui.selStaked.size} NFT${ui.selStaked.size > 1 ? "s" : ""}`
        : "Withdraw selected";
  }

  /** Reads the wallet's NFTs and splits them into free vs staked. */
  async function loadApes() {
    const s = A.state;
    if (!s.account || !s.nft || !s.farm) {
      ui.freeIds = [];
      ui.stakedIds = [];
      return;
    }
    ui.loadingApes = true;
    renderHangar();

    ui.stakedIds = s.user ? Array.from(s.user.staked).map((x) => x.toString()) : [];

    // Collections with no enumeration are discovered by an ownerOf sweep, which
    // takes a couple of seconds — report progress rather than sitting silent.
    const found = await A.discoverOwnedIds(s.account, (done, total) => {
      ui.sweepProgress = { done, total };
      renderHangar();
    });
    ui.sweepProgress = null;
    ui.discoverMethod = found.method;
    ui.discoverError = found.error || null;
    const stakedSet = new Set(ui.stakedIds);
    // A 404's owner list can lag or include ids held by the farm — filter to
    // what this wallet genuinely holds right now.
    ui.freeIds = found.ids.filter((id) => !stakedSet.has(id));

    // Drop stale selections.
    ui.selFree = new Set([...ui.selFree].filter((id) => ui.freeIds.includes(id)));
    ui.selStaked = new Set([...ui.selStaked].filter((id) => ui.stakedIds.includes(id)));

    ui.loadingApes = false;
    renderHangar();
  }

  // --------------------------------------------------------------- actions --

  async function doApprove() {
    const s = A.state;
    await A.tx("Approve farm", () => s.nft.setApprovalForAll(s.farmAddress, true));
  }

  async function doStake() {
    const ids = [...ui.selFree];
    if (!ids.length) return;
    const ok = await A.tx(`Stake ${ids.length} NFT${ids.length > 1 ? "s" : ""}`, () =>
      A.state.farm.stake(ids)
    );
    if (ok) ui.selFree.clear();
    // Ownership just changed — the cached ownerOf sweep is now stale.
    A.invalidateOwnerSweep();
    await loadApes();
  }

  async function doWithdraw() {
    const ids = [...ui.selStaked];
    if (!ids.length) return;
    const ok = await A.tx(`Withdraw ${ids.length} NFT${ids.length > 1 ? "s" : ""}`, () =>
      A.state.farm.withdraw(ids)
    );
    if (ok) ui.selStaked.clear();
    A.invalidateOwnerSweep();
    await loadApes();
  }

  async function doClaim() {
    await A.tx("Claim rewards", () => A.state.farm.getReward());
  }

  async function doExit() {
    await A.tx("Exit", () => A.state.farm.exit());
    A.invalidateOwnerSweep();
    await loadApes();
  }

  // ------------------------------------------------- change farm address UI --

  function showFarmAddressForm() {
    const host = $("notices");
    if (document.getElementById("farmAddrForm")) return;
    const box = document.createElement("div");
    box.className = "card";
    box.id = "farmAddrForm";
    box.innerHTML = `
      <div class="field">
        <label for="farmAddrInput">Farm contract address</label>
        <input id="farmAddrInput" type="text" spellcheck="false" placeholder="0x…"
               value="${A.savedFarmAddress() || A.state.farmAddress || ""}">
        <small>Stored in this browser only. Leave blank to fall back to the address in config.js.</small>
      </div>
      <div class="row row--tight">
        <button class="btn btn--primary" id="farmAddrSave">Save &amp; reload</button>
        <button class="btn btn--ghost" id="farmAddrCancel">Cancel</button>
      </div>`;
    host.prepend(box);
    $("farmAddrInput").focus();
    $("farmAddrCancel").onclick = () => box.remove();
    $("farmAddrSave").onclick = () => {
      const v = $("farmAddrInput").value.trim();
      if (v && !E.isAddress(v)) {
        A.toast("That isn't a valid address.", "error");
        return;
      }
      A.saveFarmAddress(v);
      location.reload();
    };
  }

  // ----------------------------------------------------------------- boot --

  function renderAll() {
    renderNetwork();
    renderStats();
    renderNotices();
    updateHangarButtons();
  }

  async function connectThenLoad() {
    if (await A.connect()) await loadApes();
  }

  function wire() {
    $("connectBtn").onclick = () => (A.state.account ? showFarmAddressForm() : connectThenLoad());
    $("heroConnect").onclick = () =>
      A.state.account
        ? document.getElementById("vault").scrollIntoView({ behavior: "smooth" })
        : connectThenLoad();
    $("changeFarmBtn").onclick = () => {
      showFarmAddressForm();
      $("notices").scrollIntoView({ behavior: "smooth", block: "center" });
    };

    $("approveBtn").onclick = doApprove;
    $("stakeBtn").onclick = doStake;
    $("withdrawBtn").onclick = doWithdraw;
    $("claimBtn").onclick = doClaim;
    $("exitBtn").onclick = doExit;

    $("selectAllFree").onclick = () => { ui.selFree = new Set(ui.freeIds); renderHangar(); };
    $("clearFree").onclick = () => { ui.selFree.clear(); renderHangar(); };
    $("selectAllStaked").onclick = () => { ui.selStaked = new Set(ui.stakedIds); renderHangar(); };
    $("clearStaked").onclick = () => { ui.selStaked.clear(); renderHangar(); };
  }

  async function boot() {
    wire();
    renderAll();

    A.onUpdate((s) => {
      // Keep the vault honest if the staked set moved underneath us (another
      // tab, another device, a direct contract call).
      if (s.user) {
        const fresh = Array.from(s.user.staked).map((x) => x.toString());
        if (fresh.length !== ui.stakedIds.length || fresh.some((id, i) => id !== ui.stakedIds[i])) {
          ui.stakedIds = fresh;
          renderHangar();
        }
      }
      renderAll();
    });

    const connected = await A.autoConnect();
    if (connected) await loadApes();

    // Live counter between polls, and a real re-read every 15s.
    setInterval(tickEarned, 250);
    setInterval(() => {
      if (A.state.farm) A.refresh();
    }, 15000);
    // The countdown needs its own beat so it moves without a full refresh.
    setInterval(() => {
      const info = A.state.info;
      if (A.dripLive(info)) {
        $("sRemaining").textContent = A.countdown(info.periodFinish_);
      }
    }, 1000);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
