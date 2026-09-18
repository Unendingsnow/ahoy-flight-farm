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
          "<strong>No wallet found.</strong> Install any browser wallet — MetaMask, Rabby, Brave, " +
            "Coinbase, Trust, or another injected wallet — and reload. " +
            "You can still look around in the meantime.",
          "error"
        )
      );
      return;
    }
    if (!s.account) {
      host.appendChild(notice("<strong>Not connected yet.</strong> Connect your wallet and we'll find your NFTs for you."));
      return;
    }
    if (s.farmError) {
      host.appendChild(notice(`<strong>${s.farmError}</strong> Use “Change farm” at the bottom to point somewhere else.`, "error"));
      return;
    }
    if (!s.farmAddress) {
      const target = A.defaultChainId();
      if (A.wrongNetwork()) {
        // By far the most common way to land here: the wallet is on whatever
        // chain it opened with. Say which chain, and hand them the switch.
        const el = notice(
          `<strong>Wrong network.</strong> Your wallet is on ${A.networkName(s.chainId)}, ` +
            `but this farm lives on ${A.networkName(target)}. Switch over and your NFTs will show up.`,
          "error"
        );
        const btn = document.createElement("button");
        btn.className = "btn btn--primary";
        btn.style.marginTop = "0.6rem";
        btn.textContent = `Switch to ${A.networkName(target)}`;
        btn.onclick = () => switchToFarmNetwork();
        el.querySelector("div").appendChild(btn);
        host.appendChild(el);
        return;
      }
      host.appendChild(
        notice(
          `<strong>Nothing set up on this network.</strong> ` +
            `Switch your wallet to the right network, or use “Change farm” at the bottom.`,
          "error"
        )
      );
      return;
    }
    if (!s.info) return;

    if (s.info.stakingToken_ === A.ZERO || s.info.rewardsToken_ === A.ZERO) {
      host.appendChild(
        notice(
          "<strong>Not open yet.</strong> The owner still has a little setup to finish, " +
            "so sending NFTs up is closed for now."
        )
      );
      return;
    }
    if (s.info.paused_) {
      host.appendChild(
        notice("<strong>Sending up is paused.</strong> You can still bring NFTs home and claim — they're never locked in.")
      );
    }
    if (!A.dripLive(s.info)) {
      host.appendChild(
        notice("<strong>Rewards aren't running right now.</strong> Anything already up there will start earning again the moment they are.")
      );
    }
    if (ui.discoverMethod === "unsupported" && ui.stakedIds.length === 0) {
      host.appendChild(
        notice(
          "<strong>Couldn't load your NFTs just now.</strong> This is usually a network hiccup — " +
            "refresh and try again. Anything already up there is still safe and still earning.",
          "error"
        )
      );
    }
  }

  // ----------------------------------------------------------- farm stats --

  function rewardSymbol() {
    // Empty rather than a dash: this sits directly beside the reward figure,
    // where a placeholder reads as part of the number.
    return (A.state.rewardMeta && A.state.rewardMeta.symbol) || "";
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
      info.stakerCount_ === 1n ? "1 person flying" : `${info.stakerCount_} people flying`;

    $("sPerDay").firstChild.nodeValue = live ? A.fmtCompact(perDay, dec) : "0";
    $("sPerDayUnit").textContent = sym;
    $("sPerApeDay").textContent =
      !live
        ? "paused right now"
        : totalStaked > 0n
        ? `about ${A.fmt(perDay / totalStaked, dec, 4)} ${sym} each per day`
        : `the first one up earns all ${A.fmt(perDay, dec, 4)} ${sym} a day`;

    $("sReserve").firstChild.nodeValue = A.fmtCompact(info.rewardBalance_, dec);
    $("sReserveUnit").textContent = sym;
    $("sOwed").textContent = `${A.fmt(info.outstanding_, dec, 2)} ${sym} already earned`;

    $("sRemaining").textContent = live ? A.countdown(info.periodFinish_) : "—";
    $("sDuration").textContent = `runs for ${A.duration(info.rewardsDuration_)}`;

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
      ? "Connect your wallet to start earning."
      : mine === 0n
      ? "Send an NFT up and this starts counting straight away."
      : ui.perSecond > 0n
      ? `You're earning about ${A.fmt(ui.perSecond * 3600n, dec, 4)} ${sym} an hour.`
      : "Your NFTs are up there, but rewards aren't running right now.";

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

  // Declared, not assigned — renderNotices references it before this line runs.
  function switchToFarmNetwork() {
    return A.switchToFarm();
  }

  function renderNetwork() {
    const s = A.state;
    const pill = $("netPill");
    if (!s.account) {
      pill.classList.add("hidden");
      return;
    }
    pill.classList.remove("hidden");
    const ok = Boolean(s.farmAddress) && !s.farmError;
    pill.className = "pill " + (ok ? "pill--ok" : "pill--warn");

    // The pill is in the sticky nav, so it is the one thing a scrolled-down
    // user can always see — make it say what is wrong, and fix it on click.
    if (A.wrongNetwork()) {
      $("netName").textContent = `Wrong network — switch to ${A.networkName(A.defaultChainId())}`;
      pill.style.cursor = "pointer";
      pill.title = `Your wallet is on ${A.networkName(s.chainId)}. Click to switch.`;
      pill.onclick = () => switchToFarmNetwork();
    } else {
      $("netName").textContent = `${A.networkName(s.chainId)} · ${A.shortAddr(s.account)}`;
      pill.style.cursor = "";
      pill.title = "";
      pill.onclick = null;
    }

    const wrong = A.wrongNetwork();
    const btn = $("connectBtn");
    btn.textContent = wrong ? `Switch to ${A.networkName(A.defaultChainId())}` : A.shortAddr(s.account);
    btn.title = s.wallet ? `${s.wallet.name} · ${s.account}` : s.account;
    btn.classList.toggle("btn--primary", wrong);
    $("heroConnect").textContent = wrong ? `Switch to ${A.networkName(A.defaultChainId())}` : "See my NFTs";
    // The secondary link says the same thing once connected — drop it.
    const heroAlt = document.querySelector('.hero__cta a[href="#vault"]');
    if (heroAlt) heroAlt.classList.add("hidden");
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

  function tryLoad(src) {
    return new Promise((resolve) => {
      const probe = new Image();
      probe.onload = () => resolve(true);
      probe.onerror = () => resolve(false);
      probe.src = src;
    });
  }

  /**
   * Swaps real artwork in behind the generated badges.
   *
   * One template probe up front resolves art for the entire collection, so this
   * costs no per-NFT RPC. Each card then tries a lightweight thumbnail before
   * the full-size original (which can be ~1MB), and silently keeps the badge if
   * neither loads.
   */
  async function hydrateArt(entries) {
    if (!entries.length) return;
    await A.resolveArtTemplate(entries[0].id);

    const queue = entries.slice();
    const worker = async () => {
      while (queue.length) {
        const { id, el } = queue.shift();
        if (!el.isConnected) continue;
        const art = await A.tokenArt(id);
        if (art.generated) continue;
        const img = el.querySelector("img");
        if (!img) continue;
        for (const src of [A.thumb(art.image), art.image]) {
          if (await tryLoad(src)) { img.src = src; break; }
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  }

  function renderHangar() {
    const s = A.state;
    const freeGrid = $("freeGrid");
    const stakedGrid = $("stakedGrid");
    freeGrid.innerHTML = "";
    stakedGrid.innerHTML = "";

    if (!s.account || !s.nft) {
      freeGrid.appendChild(
        emptyBox(
          A.wrongNetwork()
            ? `Your wallet is on ${A.networkName(s.chainId)}. Switch to ${A.networkName(A.defaultChainId())} to see your NFTs.`
            : s.account
              ? "Nothing to show on this network."
              : "Connect your wallet and your NFTs will show up here."
        )
      );
      stakedGrid.appendChild(emptyBox("Nothing up here yet."));
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
            : "Everything you own is already up in the air."
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
      stakedGrid.appendChild(emptyBox("Nothing up here yet. Send some up from the left and they'll start earning."));
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
    const paused = Boolean(s.info && s.info.paused_);

    // Nothing picked means "everything" — the common case is one tap, and
    // picking individual NFTs is the exception rather than a required step.
    const nFree = ui.freeIds.length;
    const pickedUp = ui.selFree.size;
    const willSend = pickedUp || nFree;

    const stakeBtn = $("stakeBtn");
    stakeBtn.disabled = !canAct || paused || willSend === 0;
    stakeBtn.textContent = paused
      ? "Paused for now"
      : willSend === 0
      ? "Nothing to send up"
      : pickedUp
      ? `Send up ${pickedUp}`
      : `Send up all ${nFree}`;

    const nUp = ui.stakedIds.length;
    const pickedDown = ui.selStaked.size;
    const willBring = pickedDown || nUp;

    const homeBtn = $("withdrawBtn");
    homeBtn.disabled = !canAct || willBring === 0;
    homeBtn.textContent =
      willBring === 0
        ? "Nothing up there yet"
        : pickedDown
        ? `Bring home ${pickedDown}`
        : `Bring home all ${nUp}`;

    const help = $("stakeHelp");
    if (help) {
      help.textContent =
        canAct && !s.approved && nFree > 0
          ? "First time only: your wallet asks for permission, then sends them up."
          : "";
    }
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

  /**
   * One button does the whole thing. Approval is not a step the user should have
   * to understand — if the farm isn't approved yet we ask for it and then send
   * up in the same press, so the happy path is always "tap, confirm, done".
   */
  async function doStake() {
    const s = A.state;
    const ids = ui.selFree.size ? [...ui.selFree] : [...ui.freeIds];
    if (!ids.length) return;

    if (!s.approved) {
      const allowed = await A.tx("Allowing the farm", () =>
        s.nft.setApprovalForAll(s.farmAddress, true)
      );
      if (!allowed) return; // rejected or failed — the toast already said so
      s.approved = true;
    }

    const ok = await A.tx(`Sending up ${ids.length}`, () => s.farm.stake(ids));
    if (ok) ui.selFree.clear();
    // Ownership just changed — the cached ownerOf sweep is now stale.
    A.invalidateOwnerSweep();
    await loadApes();
  }

  async function doWithdraw() {
    const ids = ui.selStaked.size ? [...ui.selStaked] : [...ui.stakedIds];
    if (!ids.length) return;
    const ok = await A.tx(`Bringing home ${ids.length}`, () => A.state.farm.withdraw(ids));
    if (ok) ui.selStaked.clear();
    A.invalidateOwnerSweep();
    await loadApes();
  }

  async function doClaim() {
    await A.tx("Claiming rewards", () => A.state.farm.getReward());
  }

  async function doExit() {
    await A.tx("Bringing everything home", () => A.state.farm.exit());
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
        ${A.wallets().length > 1 ? `<button class="btn btn--ghost" id="switchWalletBtn">Switch wallet</button>` : ""}
      </div>`;
    host.prepend(box);
    $("farmAddrInput").focus();
    $("farmAddrCancel").onclick = () => box.remove();
    if ($("switchWalletBtn")) {
      $("switchWalletBtn").onclick = () => {
        box.remove();
        connectThenLoad();
      };
    }
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
    // Farm.connect handles the network switch itself, and reloads if it happens.
    if (await A.connect()) await loadApes();
  }

  function wire() {
    // On the wrong chain, every connect-ish button does the one thing that
    // helps: get the wallet onto the farm's network.
    $("connectBtn").onclick = () => {
      if (A.wrongNetwork()) return switchToFarmNetwork();
      return A.state.account ? showFarmAddressForm() : connectThenLoad();
    };
    $("heroConnect").onclick = () => {
      if (A.wrongNetwork()) return switchToFarmNetwork();
      return A.state.account
        ? document.getElementById("vault").scrollIntoView({ behavior: "smooth" })
        : connectThenLoad();
    };
    $("changeFarmBtn").onclick = () => {
      showFarmAddressForm();
      $("notices").scrollIntoView({ behavior: "smooth", block: "center" });
    };

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

  // Bind to DOMContentLoaded only if it hasn't already fired — otherwise the
  // listener never runs and the page sits dead. Matters whenever the script is
  // loaded late (defer/async, injected, or bfcache restore).
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
