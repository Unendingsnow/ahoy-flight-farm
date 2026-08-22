/**
 * Live addresses and drip parameters, in one place.
 *
 * Verified on PulseChain mainnet before being written down here — see
 * `npx hardhat run scripts/precheck.js --network pulsechain`.
 */

/** Canonical Multicall3, confirmed deployed on PulseChain mainnet. */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const DAY = 24 * 60 * 60;

const TARGETS = {
  // ---------------------------------------------------------------- mainnet
  369: {
    label: "PulseChain",
    explorer: "https://scan.pulsechain.com",

    /** The wallet whose key lives in .env. */
    expectDeployer: "0xe872F01C6Aa82757586356D0323cc4FBb6519aEC",

    /**
     * THE LIVE FARM. Deployed 2026-08-22, block 27349659.
     * Funded with 30,000,000 and streaming until 2036-08-19.
     * Full record in `deployments/pulsechain.json`.
     */
    farm: "0x71432b22a63F0f14CA43e00fc269809D3570AC00",

    /**
     * The NFT collection being staked.
     *
     * NOTE: despite the "404" in its name this is a PLAIN ERC-721 — verified at
     * selector level. It exposes only the ERC-721 core: no `owned()`,
     * `ownedIds()`, `tokensOfOwner()`, no ERC721Enumerable (so no
     * `tokenOfOwnerByIndex`), and no ERC-20 side. Ids run 1..2833; `ownerOf(0)`
     * reverts. Wallet discovery therefore sweeps `ownerOf` over the id range
     * through Multicall3.
     */
    nft: "0x6f9264E1a08EbEcf5928a83663BcBEFBaFB14f6f",

    /**
     * Ids are SPARSE. `totalSupply()` returns 2833, but that is a COUNT, not a
     * high-water mark: 552 of those tokens live above id 2833, and the real
     * range is 1..3527 with gaps. Sweeping only 1..totalSupply silently loses
     * ~20% of the collection — verified against `balanceOf` for several large
     * holders, which matches exactly once the full range is swept.
     *
     * The sweep is adaptive (see `sweepOwners`): it keeps scanning past
     * `nftIdEnd` until it has accounted for `totalSupply()` tokens or hits
     * `nftIdScanCeiling`, so a future mint above 3527 cannot break discovery.
     */
    nftIdStart: 1,
    nftIdEnd: 3527,
    nftIdScanCeiling: 20000,

    /**
     * The reward token. Unverified on the explorer; empirically it applies a
     * ~4% tax on DEX-pair trades and none on plain wallet transfers. The farm
     * is correct either way — `fund()` credits the balance delta actually
     * received — but the farm cannot be marked exempt from here: this wallet
     * does NOT own the token (owner is 0x754beb10...).
     */
    rewardToken: "0x3b15eb3231740790f023bc7b9062789d531e9a21",

    /** Drip: 30,000,000 streamed over 10 years. */
    budget: 30_000_000,
    durationDays: 3650,
  },
};

/** Seconds in the configured drip window. */
function durationSeconds(chainId) {
  return TARGETS[chainId].durationDays * DAY;
}

module.exports = { TARGETS, MULTICALL3, DAY, durationSeconds };
