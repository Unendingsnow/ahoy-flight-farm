# NFT Stake Farm

Stake NFTs by token ID, earn a hard-capped reward drip, withdraw the identical
tokens. Ships with a staker-facing site and a private owner control panel.

Built for **PulseChain** (chainId 369) and rehearsed against a mainnet fork
before every live change.

> **The farm deploys unconfigured on purpose.** Both the NFT collection and the
> reward token are set *after* deployment. The same deployment can be pointed at
> a different collection or reward token later — while nothing is staked — with
> no redeploy and no code change.

---

## Quick start

```bash
npm install
npm run compile
npm test                  # 91 unit + property tests

npm run precheck          # read-only checks against live PulseChain
npm run battletest        # full rehearsal on a mainnet fork (61 assertions)
```

Local development:

```bash
npm run node              # terminal 1 — local PulseChain-style node
npm run deploy:local      # terminal 2 — mocks + a bare farm
npm run web               # http://127.0.0.1:8080  (admin at /admin.html)
```

---

## Live targets

Everything below was verified on PulseChain mainnet — see `scripts/targets.js`.

| What | Address |
| --- | --- |
| **THE FARM (live)** | **`0x71432b22a63F0f14CA43e00fc269809D3570AC00`** |
| NFT collection | `0x6f9264E1a08EbEcf5928a83663BcBEFBaFB14f6f` |
| Reward token | `0x3b15eb3231740790f023bc7b9062789d531e9a21` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

**Live since** 2026-08-22, block 27349659 —
[view on the explorer](https://scan.pulsechain.com/address/0x71432b22a63F0f14CA43e00fc269809D3570AC00).
Owner is the deployer wallet; funded with the full 30,000,000 (nothing lost to
transfer tax) and streaming until **2036-08-19**. The full record, including gas
and the exact rate, is in `deployments/pulsechain.json`.

**Drip:** 30,000,000 over 3650 days → `0.095129375951293759` / second
(8,219.18 / day, 3,000,000 / year). With all 2,833 tokens staked that is
**2.90 per NFT per day**, ~1,058.95 per NFT per year. Fewer staked ⇒ each earns
proportionally more; the total never changes.

### Three things the chain told us that the code didn't

These were all discovered by probing mainnet, and each one changed the build.

**1. The collection is a plain ERC-721, not an ERC-404.**
Despite the name, it exposes only the ERC-721 core — confirmed at selector level.
No `owned()`, `ownedIds()`, `tokensOfOwner()`, no ERC721Enumerable (so no
`tokenOfOwnerByIndex`), and no ERC-20 side at all. The farm is unaffected: it
only ever calls `transferFrom` and `ownerOf`. The *site* was affected — see below.

**2. Token IDs are sparse, and `totalSupply()` is a count, not a maximum.**
`totalSupply()` returns **2833**, but the ids actually run **1 … 3527**, with 552
tokens living above 2833. Sweeping `1..totalSupply` silently loses ~20% of the
collection. The sweep is therefore adaptive: it keeps scanning until every token
is accounted for. Verified against `balanceOf` for the largest holders — 275,
111 and 58 all match exactly, and the sweep totals exactly 2833 across 885
holders.

**3. The reward token does not tax the farm.**
It is unverified on the explorer and does apply ~4% on DEX-pair trades, so this
could not be settled by reading source. Measured on a fork against the real
contract: `fund()` moved the full 30,000,000 with **zero** skimmed, and
`getReward()` paid stakers **exactly** what they earned. The farm is correct
either way — `fund()` credits the balance delta actually received — but it is
worth knowing the budget lands whole, because this wallet does **not** own the
reward token and so cannot grant itself an exemption.

---

## How the farm works

**Reward model — a hard, budgeted drip** (the audited Synthetix
`StakingRewards` accumulator, stake weight = number of NFTs staked):

- Fund a fixed amount, stream it over a fixed window.
- Every staked NFT is one equal share; rewards split pro-rata, second by second.
- **Fewer staked ⇒ each earns a bigger slice.** The total never changes.
- Total emitted can never exceed what was actually deposited.

**Stakers are never trapped.** `withdraw()` and `getReward()` cannot be paused,
and the owner's rescue functions cannot touch a staked token or a reward already
earned.

**Exact-ID safety.** NFTs are pulled by specific ID and each is verified to have
landed (`ownerOf(id) == farm`). If a collection ever rerolled ids on transfer the
stake reverts rather than silently swapping a rare — `MockRerollingCollection`
keeps that path under test even though the live collection is a plain ERC-721.

### Owner guarantees, enforced on-chain

| Action | Guard |
| --- | --- |
| `setStakingToken` | Only while `totalStaked == 0` — nothing can be stranded behind a swapped address. |
| `setRewardsToken` | Only while nothing is staked **and** no drip is running. Opens a new reward epoch. |
| `notifyRewardAmount` | Rate must be covered by `balance − outstanding`. Claims can never bounce. |
| `recoverERC20` | Never the staking token. The reward token only down to `unallocatedRewards()`. |
| `recoverERC721` | Never a staked token. |
| `setStakingPaused` | Blocks new stakes only. Withdraw and claim always work. |

**Reward epochs.** Changing the reward token bumps `rewardEpoch`. Rewards earned
but unclaimed under the old token are *dropped* rather than repaid out of the new
token's budget, and the old token's leftover balance returns to the owner in the
same transaction. `outstandingRewards()` reports exactly what would be written
off before you switch.

---

## Deploying live

```bash
npm run precheck    # key resolves? gas? balances? collection sane?
npm run battletest   # full rehearsal against real contracts on a fork
npx hardhat run scripts/deploy-live.js --network pulsechain          # DRY RUN
CONFIRM=DEPLOY npx hardhat run scripts/deploy-live.js --network pulsechain
```

`deploy-live.js` sends **nothing** without `CONFIRM=DEPLOY`. The dry run
simulates the deploy, prints the gas estimate and the full emission maths, and
stops. The live path then runs the same sequence the admin panel would:

```
deploy bare -> setStakingToken -> setRewardsToken -> setRewardsDuration
            -> approve -> fund -> notifyRewardAmount
```

It writes `deployments/pulsechain.json`, updates `web/config.js`, and regenerates
`web/abi.js`.

> The deployer key is read from `.env`. Both `PRIVATE_KEY` and the hyphenated
> `Deployer-PK` are accepted; the parser is inline in `hardhat.config.js` so the
> project keeps zero runtime dependencies.

### Two things worth doing after launch

1. Ask the collection owner to mark the farm **ERC-721 transfer-exempt** if the
   collection supports it — a gas saver only; the farm is correct either way.
2. Ask the reward-token owner to mark the farm **tax-exempt**. Currently
   unnecessary (measured at 0% both directions), but it makes that guarantee
   explicit rather than incidental.

---

## Shanghai, not Cancun — this is load-bearing

PulseChain has **not** adopted Cancun. `evmVersion` is pinned to `shanghai` in
`hardhat.config.js`; bumping it produces bytecode using `mcopy` / transient
storage that reverts on chain.

This is also why `MockPlainERC721` is hand-written instead of inheriting
OpenZeppelin: OZ 5.6's `Strings` → `Bytes` uses `mcopy`, so importing `ERC721`
breaks the Shanghai build outright.

Forking PulseChain additionally needs a hardfork activation history — Hardhat
ships one only for chains it knows — hence the `chains` block in the config.

---

## The website

Self-contained: ethers is vendored, no CDN calls, no build step, no framework.
`web/abi.js` is generated from the compiled artifacts so the site's ABI cannot
drift from the contract.

- **The site needs only the farm address.** The collection, the reward token and
  its symbol/decimals are all read off the farm via `farmInfo()`.
- **Ownership discovery degrades gracefully.** It probes `owned()`, `ownedIds()`,
  `tokensOfOwner()`, then `balanceOf` + `tokenOfOwnerByIndex`, and finally falls
  back to an adaptive `ownerOf` sweep through **Multicall3** — which works
  against any ERC-721 whatsoever. The live collection needs that fallback; the
  full sweep of 2,833 tokens takes ~2.6s and is cached for 60s, invalidated
  whenever ownership changes.
- **Artwork falls back gracefully.** `tokenURI` → metadata → image, with IPFS
  rewriting and a 7s timeout; failures render a deterministic badge.
- **Times come from chain time**, not the browser clock.

The admin panel (`web/admin.html`, `web/assets/admin.js`) is **gitignored** —
keep it local.

### Deploying the site to Vercel

The site is static with no build step, so Vercel just serves `web/`:

```bash
npm i -g vercel     # once
vercel              # preview URL
vercel --prod       # production URL
```

`vercel.json` sets `outputDirectory: "web"` with no build/install command, plus
cache headers (`vendor/` immutable, `config.js` / `abi.js` never cached so a
redeploy always picks up a new farm address).

**`.vercelignore` is a safety control, not tidiness.** The `vercel` CLI uploads
the *working tree*, not the git index — so `.gitignore` alone would not stop it
publishing `.env` (your private key) or the owner control panel. `.vercelignore`
excludes both explicitly. If you change the deploy method, keep those exclusions.

Two things to check after a deploy:

1. `web/config.js` carries the live farm address — `deploy-live.js` writes it, so
   redeploy the site after deploying the contract.
2. The site is read-only until a wallet connects, and needs the wallet on
   PulseChain (369). It also accepts `?farm=0x…` to point at a different
   deployment without a redeploy.

---

## Testing

```
npm test              # 91 unit + property tests
npm run test:soak     # randomised soak across 5 seeds
npm run battletest    # 61 assertions against real contracts on a mainnet fork
```

| Suite | What it pins down |
| --- | --- |
| `nftFarm.test.js` | Staking, the drip split, exact-ID return, owner controls, rescue. |
| `farmConfig.test.js` | Late binding, every setter guard, epochs, pause, `cancelDrip`, funding helpers. |
| `rewardToken.test.js` | Tax mechanics, plus the farm against a taxed reward token — exempt and not. |
| `invariants.test.js` | Randomised multi-actor soak, re-checking every invariant after **each** step. |
| `plainErc721.test.js` | The farm against a plain, non-enumerable ERC-721 — **the live shape**, including that the collection really lacks every enumeration method the site probes for. |
| `burnToken.test.js` | The fixed-supply self-burning ERC-20 test double. |

Invariants asserted continuously:

- `totalStaked` equals the sum of per-wallet stakes; `stakerCount` matches.
- Every staked ID is held by the farm and attributed to its staker; every
  unstaked ID is back with its owner.
- `rewardBalance ≥ outstanding + scheduled` — never insolvent, never
  over-committed.
- Total paid out never exceeds total funded; after everyone exits, every token is
  home and only rounding dust remains.

**The fork battle test** (`scripts/fork-battletest.js`) is the real safety net.
It impersonates genuine on-chain holders, deploys the farm against the **real**
collection and **real** reward token, and drives the whole lifecycle: wire →
fund → drip → stake → accrue → split → claim → partial withdraw → exit →
solvency → owner guards → cancel. It is what proved the tax behaviour and caught
the sparse-ID bug.

Reproduce a soak failure from its printed seed:

```bash
FARM_SEED=42 FARM_ROUNDS=800 npx hardhat test test/invariants.test.js
```

---

## Contract reference (`NftStakeFarm`)

**Staker**

| Function | Notes |
| --- | --- |
| `stake(uint256[] ids)` | Needs `setApprovalForAll(farm, true)` first. Verifies each ID landed. |
| `withdraw(uint256[] ids)` | Returns the identical IDs. Never pausable. |
| `getReward()` | Claim accrued rewards. Never pausable. |
| `exit()` | Withdraw everything and claim. |
| `earned(address)` / `userInfo(address)` | Pending rewards; IDs + pending + per-second share. |

**Owner**

| Function | Notes |
| --- | --- |
| `setStakingToken(address)` | Only while nothing is staked. |
| `setRewardsToken(address)` | Only while nothing is staked and no drip runs. New epoch. |
| `setRewardsDuration(uint256)` | Only between windows. |
| `fund(uint256)` | Anyone may call. Credits the amount actually received. |
| `fundAndStart(uint256)` | Fund, then stream the whole unallocated balance. |
| `notifyRewardAmount(uint256)` | Start/extend. Un-streamed remainder rolls into the new rate. |
| `cancelDrip()` | Stop now. Earned stays owed; the rest becomes unallocated. |
| `setStakingPaused(bool)` | New stakes only. |
| `recoverERC20` / `recoverERC721` | Guarded as above. |

**Views**

`farmInfo()` returns everything the UI needs in one call. `outstandingRewards()`
(earned, unclaimed — a hard liability), `scheduledRewards()` (promised to the
rest of the window), `unallocatedRewards()` (free to re-notify or recover).

> ⚠️ The `mocks/` contracts are test doubles. Never deploy them to production.
