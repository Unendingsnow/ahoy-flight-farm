const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const E = ethers.parseEther;

// Deterministic PRNG so a failure is always reproducible from the printed seed.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Randomised multi-actor simulation. Hundreds of interleaved stakes,
 * withdrawals, claims, top-ups and time jumps, with every core invariant
 * re-checked after each step.
 */
describe("NftStakeFarm — randomised soak & invariants", function () {
  this.timeout(600000);

  const SEED = Number(process.env.FARM_SEED || 20260726);
  // Crank with e.g. FARM_ROUNDS=600 FARM_SEED=7 npm test  (see `npm run test:soak`).
  const ROUNDS = Number(process.env.FARM_ROUNDS || 120);

  async function setup(taxed) {
    const [owner, ...rest] = await ethers.getSigners();
    const actors = rest.slice(0, 4);

    const Mock = await ethers.getContractFactory("MockNftCollection");
    const nft = await Mock.deploy(E("10000"));
    const nftAddr = await nft.getAddress();

    const Reward = await ethers.getContractFactory("MockRewardToken");
    const reward = await Reward.deploy(
      "Test Reward", "TRWD", owner.address, E("100000000"), owner.address, owner.address
    );
    const rewardAddr = await reward.getAddress();

    const Farm = await ethers.getContractFactory("NftStakeFarm");
    const farm = await Farm.deploy(owner.address, rewardAddr, nftAddr);
    const farmAddr = await farm.getAddress();

    await nft.setWhitelist(farmAddr, true);
    if (taxed) {
      // Worst case: the farm pays the token's 3% on the way in and out.
      await reward.setTaxAllTransfers(true);
      await reward.setTaxExempt(owner.address, false);
    } else {
      await reward.setTaxExempt(farmAddr, true);
    }

    const owned = new Map();
    for (const a of actors) {
      await nft.transfer(a.address, E("6"));
      await nft.connect(a).setApprovalForAll(farmAddr, true);
      owned.set(a.address, (await nft.ownedIds(a.address)).map((x) => x.toString()));
    }

    return { owner, actors, nft, reward, farm, farmAddr, rewardAddr, owned };
  }

  async function checkInvariants(ctx) {
    const { actors, nft, farm, farmAddr, owned } = ctx;

    let sumStaked = 0n;
    let liveStakers = 0n;
    for (const a of actors) {
      const staked = (await farm.stakedTokens(a.address)).map((x) => x.toString());
      sumStaked += BigInt(staked.length);
      if (staked.length > 0) liveStakers += 1n;

      const stakedSet = new Set(staked);
      expect(stakedSet.size, "duplicate id in a wallet's staked list").to.equal(staked.length);

      for (const id of staked) {
        // A staked NFT is held by the farm and attributed to its staker.
        expect(await nft.ownerOf(id), `staked ${id} not held by farm`).to.equal(farmAddr);
        expect(await farm.stakerOf(id), `staked ${id} misattributed`).to.equal(a.address);
      }
      for (const id of owned.get(a.address)) {
        // Anything not staked is back in the owner's wallet — never stranded.
        if (!stakedSet.has(id)) {
          expect(await nft.ownerOf(id), `unstaked ${id} not with its owner`).to.equal(a.address);
          expect(await farm.stakerOf(id)).to.equal(ethers.ZeroAddress);
        }
      }
    }

    expect(await farm.totalStaked(), "totalStaked desync").to.equal(sumStaked);
    expect(await farm.stakerCount(), "stakerCount desync").to.equal(liveStakers);

    // Solvency: the farm always physically holds what it already owes.
    const balance = await farm.rewardBalance();
    const outstanding = await farm.outstandingRewards();
    expect(balance, "farm is insolvent").to.be.gte(outstanding);

    // And it holds what it owes PLUS everything still scheduled to stream.
    expect(balance, "drip is over-committed").to.be.gte(outstanding + (await farm.scheduledRewards()));
  }

  async function soak(taxed) {
    const ctx = await setup(taxed);
    const { owner, actors, reward, farm, farmAddr, owned } = ctx;
    const rand = rng(SEED);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];

    // Initial drip: 1M over 100 days.
    await farm.connect(owner).setRewardsDuration(100 * DAY);
    await reward.connect(owner).approve(farmAddr, E("100000000"));
    await farm.connect(owner).fund(E("1000000"));
    await farm.connect(owner).notifyRewardAmount(await farm.unallocatedRewards());

    let totalFunded = await farm.rewardBalance();
    const claimed = new Map(actors.map((a) => [a.address, 0n]));

    for (let i = 0; i < ROUNDS; i++) {
      const actor = pick(actors);
      const roll = rand();

      const stakedNow = (await farm.stakedTokens(actor.address)).map((x) => x.toString());
      const free = owned.get(actor.address).filter((id) => !stakedNow.includes(id));

      if (roll < 0.35 && free.length > 0) {
        const n = 1 + Math.floor(rand() * free.length);
        await farm.connect(actor).stake(free.slice(0, n));
      } else if (roll < 0.6 && stakedNow.length > 0) {
        const n = 1 + Math.floor(rand() * stakedNow.length);
        await farm.connect(actor).withdraw(stakedNow.slice(0, n));
      } else if (roll < 0.78) {
        const before = await reward.balanceOf(actor.address);
        await farm.connect(actor).getReward();
        claimed.set(actor.address, claimed.get(actor.address) + ((await reward.balanceOf(actor.address)) - before));
      } else if (roll < 0.86 && stakedNow.length > 0) {
        const before = await reward.balanceOf(actor.address);
        await farm.connect(actor).exit();
        claimed.set(actor.address, claimed.get(actor.address) + ((await reward.balanceOf(actor.address)) - before));
      } else if (roll < 0.92) {
        // Owner tops the farm up and rolls the leftover into a fresh window.
        const before = await farm.rewardBalance();
        await farm.connect(owner).fund(E("50000"));
        totalFunded += (await farm.rewardBalance()) - before;
        const free = await farm.unallocatedRewards();
        if (free > 0n) await farm.connect(owner).notifyRewardAmount(free);
      } else {
        await time.increase(1 + Math.floor(rand() * 5 * DAY));
      }

      await checkInvariants(ctx);
    }

    // Everyone exits; the farm must end empty and every NFT must go home.
    await time.increase(200 * DAY);
    for (const a of actors) {
      const before = await reward.balanceOf(a.address);
      await farm.connect(a).exit();
      claimed.set(a.address, claimed.get(a.address) + ((await reward.balanceOf(a.address)) - before));
    }
    await checkInvariants(ctx);

    expect(await farm.totalStaked()).to.equal(0);
    expect(await farm.stakerCount()).to.equal(0);
    for (const a of actors) {
      for (const id of owned.get(a.address)) {
        expect(await ctx.nft.ownerOf(id), `NFT ${id} did not come home`).to.equal(a.address);
      }
      expect(await farm.earned(a.address), "residual claim after exit").to.equal(0);
    }

    // Nothing was conjured: total paid out never exceeds total funded.
    const totalPaid = [...claimed.values()].reduce((a, b) => a + b, 0n);
    expect(totalPaid, "paid out more than was funded").to.be.lte(totalFunded);

    return { totalPaid, totalFunded, dust: await farm.rewardBalance() };
  }

  it(`holds all invariants over a randomised run (untaxed reward token, seed ${SEED})`, async function () {
    const { totalPaid, totalFunded, dust } = await soak(false);
    // Only rounding dust should be left behind.
    expect(dust).to.be.lt(E("1"));
    expect(totalPaid).to.be.closeTo(totalFunded, E("1"));
  });

  it(`holds all invariants over a randomised run (3%-taxed reward token, seed ${SEED})`, async function () {
    const { totalPaid, totalFunded, dust } = await soak(true);
    expect(dust).to.be.lt(E("1"));
    // Stakers net 97% — the token's tax, and nothing is stuck in the farm.
    expect(totalPaid).to.be.closeTo((totalFunded * 9700n) / 10000n, E("1"));
  });

  describe("404 reroll safety", function () {
    it("stake() reverts rather than accept a rerolled tokenId", async function () {
      const [owner, alice] = await ethers.getSigners();

      const Hostile = await ethers.getContractFactory("MockRerollingCollection");
      const hostile = await Hostile.deploy();
      const Reward = await ethers.getContractFactory("MockRewardToken");
      const reward = await Reward.deploy(
        "Test Reward", "TRWD", owner.address, E("1000"), owner.address, owner.address
      );

      const Farm = await ethers.getContractFactory("NftStakeFarm");
      const farm = await Farm.deploy(owner.address, await reward.getAddress(), await hostile.getAddress());
      const farmAddr = await farm.getAddress();

      await hostile.mint(alice.address); // id 1 — alice's rare NFT
      await hostile.connect(alice).setApprovalForAll(farmAddr, true);

      await expect(farm.connect(alice).stake([1])).to.be.revertedWith("id not received");
      // Nothing was recorded and no state leaked from the reverted call.
      expect(await farm.totalStaked()).to.equal(0);
      expect(await farm.stakerOf(1)).to.equal(ethers.ZeroAddress);
    });
  });
});
