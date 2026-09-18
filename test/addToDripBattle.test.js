const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const TEN_YEARS = 3650 * DAY;
const E = ethers.parseEther;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Battle test for `addToDrip` — the adversarial counterpart to
 * addToDrip.test.js, which only pins down the happy path.
 *
 * The thing being defended here is that recycling surplus into a LIVE window
 * cannot: move the end date, pay anyone retroactively, make the farm insolvent,
 * emit more than was funded, or silently do nothing.
 */
describe("NftStakeFarm — addToDrip BATTLE TEST", function () {
  this.timeout(900000);

  const SEED = Number(process.env.FARM_SEED || 20260826);
  const ROUNDS = Number(process.env.FARM_ROUNDS || 150);

  async function setup({ taxed = false, actorCount = 4 } = {}) {
    const [owner, ...rest] = await ethers.getSigners();
    const actors = rest.slice(0, actorCount);

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

  async function openWindow(farm, reward, owner, farmAddr, amount, duration) {
    await farm.connect(owner).setRewardsDuration(duration);
    await reward.connect(owner).approve(farmAddr, E("100000000"));
    await farm.connect(owner).fund(amount);
    await farm.connect(owner).notifyRewardAmount(await farm.unallocatedRewards());
  }

  /** Everything that must hold no matter what just happened. */
  async function checkInvariants(ctx, note) {
    const { actors, nft, farm, farmAddr, owned } = ctx;

    let sumStaked = 0n;
    let liveStakers = 0n;
    for (const a of actors) {
      const staked = (await farm.stakedTokens(a.address)).map((x) => x.toString());
      sumStaked += BigInt(staked.length);
      if (staked.length > 0) liveStakers += 1n;

      const stakedSet = new Set(staked);
      for (const id of staked) {
        expect(await nft.ownerOf(id), `${note}: staked ${id} not held by farm`).to.equal(farmAddr);
        expect(await farm.stakerOf(id), `${note}: staked ${id} misattributed`).to.equal(a.address);
      }
      for (const id of owned.get(a.address)) {
        if (!stakedSet.has(id)) {
          expect(await nft.ownerOf(id), `${note}: unstaked ${id} stranded`).to.equal(a.address);
        }
      }
    }
    expect(await farm.totalStaked(), `${note}: totalStaked desync`).to.equal(sumStaked);
    expect(await farm.stakerCount(), `${note}: stakerCount desync`).to.equal(liveStakers);

    const balance = await farm.rewardBalance();
    const outstanding = await farm.outstandingRewards();
    const scheduled = await farm.scheduledRewards();
    expect(balance, `${note}: insolvent`).to.be.gte(outstanding);
    expect(balance, `${note}: drip over-committed`).to.be.gte(outstanding + scheduled);
  }

  // =========================================================================
  describe("Randomised adversarial soak", function () {
    async function soak(taxed) {
      const ctx = await setup({ taxed });
      const { owner, actors, reward, farm, farmAddr, owned } = ctx;
      const rand = rng(SEED);
      const pick = (arr) => arr[Math.floor(rand() * arr.length)];

      await openWindow(farm, reward, owner, farmAddr, E("1000000"), 400 * DAY);

      let totalFunded = await farm.rewardBalance();
      let expectedFinish = await farm.periodFinish();
      let topUps = 0;
      let emptyStretches = 0;
      const claimed = new Map(actors.map((a) => [a.address, 0n]));

      for (let i = 0; i < ROUNDS; i++) {
        const actor = pick(actors);
        const roll = rand();
        const stakedNow = (await farm.stakedTokens(actor.address)).map((x) => x.toString());
        const free = owned.get(actor.address).filter((id) => !stakedNow.includes(id));

        if (roll < 0.28 && free.length > 0) {
          await farm.connect(actor).stake(free.slice(0, 1 + Math.floor(rand() * free.length)));
        } else if (roll < 0.5 && stakedNow.length > 0) {
          await farm.connect(actor).withdraw(stakedNow.slice(0, 1 + Math.floor(rand() * stakedNow.length)));
        } else if (roll < 0.65) {
          const before = await reward.balanceOf(actor.address);
          await farm.connect(actor).getReward();
          claimed.set(actor.address, claimed.get(actor.address) + ((await reward.balanceOf(actor.address)) - before));
        } else if (roll < 0.72 && stakedNow.length > 0) {
          const before = await reward.balanceOf(actor.address);
          await farm.connect(actor).exit();
          claimed.set(actor.address, claimed.get(actor.address) + ((await reward.balanceOf(actor.address)) - before));
        } else if (roll < 0.86) {
          // THE MOVE UNDER TEST: recycle whatever surplus exists, mid-window.
          const surplus = await farm.unallocatedRewards();
          const remaining = expectedFinish - BigInt(await time.latest());
          if (surplus > 0n && remaining > 0n && surplus / remaining > 0n) {
            const rateBefore = await farm.rewardRate();
            await farm.connect(owner).addToDrip(surplus);
            topUps += 1;

            expect(await farm.periodFinish(), "addToDrip moved the end date").to.equal(expectedFinish);
            expect(await farm.rewardRate(), "addToDrip did not raise the rate").to.be.gt(rateBefore);
          }
        } else if (roll < 0.9) {
          const before = await farm.rewardBalance();
          await farm.connect(owner).fund(E("25000"));
          totalFunded += (await farm.rewardBalance()) - before;
        } else {
          // Time jump. When nobody is staked this is exactly what mints surplus.
          if ((await farm.totalStaked()) === 0n) emptyStretches += 1;
          await time.increase(1 + Math.floor(rand() * 8 * DAY));
        }

        await checkInvariants(ctx, `round ${i}`);
      }

      // Wind down: everyone out, window run to the end.
      await time.increase(500 * DAY);
      for (const a of actors) {
        const before = await reward.balanceOf(a.address);
        await farm.connect(a).exit();
        claimed.set(a.address, claimed.get(a.address) + ((await reward.balanceOf(a.address)) - before));
      }
      await checkInvariants(ctx, "wind-down");

      expect(await farm.totalStaked()).to.equal(0);
      for (const a of actors) {
        for (const id of owned.get(a.address)) {
          expect(await ctx.nft.ownerOf(id), `NFT ${id} did not come home`).to.equal(a.address);
        }
        expect(await farm.earned(a.address), "residual claim after exit").to.equal(0);
      }

      const totalPaid = [...claimed.values()].reduce((a, b) => a + b, 0n);
      expect(totalPaid, "paid out more than was funded").to.be.lte(totalFunded);

      return { totalPaid, totalFunded, topUps, emptyStretches };
    }

    it(`survives ${ROUNDS} interleaved rounds with top-ups (untaxed, seed ${SEED})`, async function () {
      const r = await soak(false);
      expect(r.topUps, "the soak never actually exercised addToDrip").to.be.gt(0);
      console.log(`        ${r.topUps} top-ups, ${r.emptyStretches} empty stretches`);
    });

    it(`survives ${ROUNDS} interleaved rounds with top-ups (3%-taxed, seed ${SEED})`, async function () {
      const r = await soak(true);
      expect(r.topUps).to.be.gt(0);
      console.log(`        ${r.topUps} top-ups, ${r.emptyStretches} empty stretches`);
    });
  });

  // =========================================================================
  describe("Boundaries", function () {
    it("a top-up too small to move the rate is rejected, not silently swallowed", async function () {
      const { owner, farm, reward, farmAddr, actors, nft } = await setup();
      await openWindow(farm, reward, owner, farmAddr, E("30000000"), TEN_YEARS);
      await time.increase(30 * DAY);
      await farm.connect(actors[0]).stake([(await nft.ownedIds(actors[0].address))[0]]);

      // 1 wei over a 10-year window truncates to a rate delta of zero. Silently
      // succeeding would tell the owner the surplus was recycled when it wasn't.
      await expect(farm.connect(owner).addToDrip(1n)).to.be.revertedWith("Amount too small for window");
    });

    it("works with one second left in the window", async function () {
      const { owner, farm, reward, farmAddr, actors, nft } = await setup();
      await openWindow(farm, reward, owner, farmAddr, E("1000000"), 30 * DAY);
      await farm.connect(actors[0]).stake([(await nft.ownedIds(actors[0].address))[0]]);

      const finish = await farm.periodFinish();
      await time.increaseTo(finish - 2n);

      const surplus = await farm.unallocatedRewards();
      if (surplus > 0n) {
        await farm.connect(owner).addToDrip(surplus);
        expect(await farm.periodFinish()).to.equal(finish);
        const balance = await farm.rewardBalance();
        expect(balance).to.be.gte((await farm.outstandingRewards()) + (await farm.scheduledRewards()));
      }
    });

    it("recycling the entire surplus never over-commits the farm", async function () {
      const { owner, farm, reward, farmAddr, actors, nft } = await setup();
      await openWindow(farm, reward, owner, farmAddr, E("30000000"), TEN_YEARS);

      // A long empty stretch: a quarter of the window with nobody staked.
      await time.increase(900 * DAY);
      await farm.connect(actors[0]).stake([(await nft.ownedIds(actors[0].address))[0]]);

      const surplus = await farm.unallocatedRewards();
      expect(surplus).to.be.gt(E("7000000"));
      await farm.connect(owner).addToDrip(surplus);

      const balance = await farm.rewardBalance();
      const committed = (await farm.outstandingRewards()) + (await farm.scheduledRewards());
      expect(balance).to.be.gte(committed);

      // Run the window out and confirm the last staker can still be paid.
      await time.increase(TEN_YEARS);
      await expect(farm.connect(actors[0]).exit()).to.not.be.reverted;
      expect(await farm.rewardBalance()).to.be.lt(E("1"), "more than dust stranded");
    });

    it("cannot be used to pay out more than was ever funded", async function () {
      const { owner, farm, reward, farmAddr, actors, nft, owned } = await setup({ actorCount: 3 });
      const budget = E("1000000");
      await openWindow(farm, reward, owner, farmAddr, budget, 200 * DAY);

      // Alternate empty stretches with top-ups, for the whole window.
      for (let i = 0; i < 8; i++) {
        await time.increase(10 * DAY); // empty -> surplus
        const ids = owned.get(actors[i % 3].address);
        await farm.connect(actors[i % 3]).stake([ids[0]]);
        await time.increase(5 * DAY);

        const surplus = await farm.unallocatedRewards();
        const remaining = (await farm.periodFinish()) - BigInt(await time.latest());
        if (surplus > 0n && remaining > 0n && surplus / remaining > 0n) {
          await farm.connect(owner).addToDrip(surplus);
        }
        await farm.connect(actors[i % 3]).withdraw([ids[0]]);
      }

      await time.increase(400 * DAY);
      let paid = 0n;
      for (const a of actors) {
        const before = await reward.balanceOf(a.address);
        await farm.connect(a).exit();
        paid += (await reward.balanceOf(a.address)) - before;
      }
      expect(paid, "emitted more than the budget").to.be.lte(budget);
    });
  });

  // =========================================================================
  describe("Fairness across stakers", function () {
    it("the raised rate is split pro-rata, and only for time actually staked", async function () {
      const { owner, farm, reward, farmAddr, actors, owned } = await setup({ actorCount: 3 });
      const [alice, bob, carol] = actors;
      await openWindow(farm, reward, owner, farmAddr, E("30000000"), TEN_YEARS);

      await time.increase(200 * DAY); // empty -> surplus to recycle

      await farm.connect(alice).stake([owned.get(alice.address)[0]]);
      await farm.connect(bob).stake(owned.get(bob.address).slice(0, 3));
      await farm.connect(owner).addToDrip(await farm.unallocatedRewards());

      await time.increase(50 * DAY);

      const aliceEarned = await farm.earned(alice.address);
      const bobEarned = await farm.earned(bob.address);
      // Bob has 3 NFTs to Alice's 1 over the same window.
      expect(bobEarned).to.be.closeTo(aliceEarned * 3n, aliceEarned / 100n);
      // Carol never staked and never earns a thing.
      expect(await farm.earned(carol.address)).to.equal(0);
    });

    it("a staker who joins after the top-up earns at the new rate, not the old", async function () {
      const { owner, farm, reward, farmAddr, actors, owned } = await setup({ actorCount: 2 });
      const [alice, bob] = actors;
      await openWindow(farm, reward, owner, farmAddr, E("30000000"), TEN_YEARS);

      await time.increase(300 * DAY);
      await farm.connect(alice).stake([owned.get(alice.address)[0]]);
      await time.increase(10 * DAY);
      const aliceBeforeTopUp = await farm.earned(alice.address);

      await farm.connect(owner).addToDrip(await farm.unallocatedRewards());
      const aliceAtTopUp = await farm.earned(alice.address);

      // Bob joins now; both hold 1 NFT, so over the next stretch they earn the
      // same, and each earns more per day than Alice did before the top-up.
      await farm.connect(bob).stake([owned.get(bob.address)[0]]);
      await time.increase(10 * DAY);

      const aliceAfter = (await farm.earned(alice.address)) - aliceAtTopUp;
      const bobAfter = await farm.earned(bob.address);
      expect(bobAfter).to.be.closeTo(aliceAfter, aliceAfter / 50n);
      // Half the pot each now, yet still ahead of the old solo rate.
      expect(bobAfter * 2n).to.be.gt(aliceBeforeTopUp);
    });
  });

  // =========================================================================
  describe("Interaction with every other owner control", function () {
    it("notifyRewardAmount after addToDrip stays solvent and re-spreads correctly", async function () {
      const { owner, farm, reward, farmAddr, actors, owned } = await setup();
      await openWindow(farm, reward, owner, farmAddr, E("30000000"), TEN_YEARS);
      await time.increase(200 * DAY);
      await farm.connect(actors[0]).stake([owned.get(actors[0].address)[0]]);

      await farm.connect(owner).addToDrip(await farm.unallocatedRewards());
      await time.increase(30 * DAY);

      await farm.connect(owner).fund(E("500000"));
      await farm.connect(owner).notifyRewardAmount(await farm.unallocatedRewards());

      const balance = await farm.rewardBalance();
      expect(balance).to.be.gte((await farm.outstandingRewards()) + (await farm.scheduledRewards()));
    });

    it("cancelDrip after addToDrip frees the raised schedule, and recoverERC20 respects the debt", async function () {
      const { owner, farm, reward, farmAddr, actors, owned } = await setup();
      await openWindow(farm, reward, owner, farmAddr, E("30000000"), TEN_YEARS);
      await time.increase(200 * DAY);
      await farm.connect(actors[0]).stake([owned.get(actors[0].address)[0]]);
      await farm.connect(owner).addToDrip(await farm.unallocatedRewards());
      await time.increase(30 * DAY);

      const owed = await farm.outstandingRewards();
      expect(owed).to.be.gt(0);

      await farm.connect(owner).cancelDrip();
      expect(await farm.scheduledRewards()).to.equal(0);

      // The owner can take everything EXCEPT what stakers already earned.
      const free = await farm.unallocatedRewards();
      await expect(
        farm.connect(owner).recoverERC20(await reward.getAddress(), free + E("1"))
      ).to.be.revertedWith("Exceeds unallocated rewards");
      await farm.connect(owner).recoverERC20(await reward.getAddress(), free);

      // And the staker still gets paid in full.
      const before = await reward.balanceOf(actors[0].address);
      await farm.connect(actors[0]).exit();
      expect((await reward.balanceOf(actors[0].address)) - before).to.be.gte((owed * 99n) / 100n);
    });

    it("pausing staking does not block a top-up, and stakers keep earning", async function () {
      const { owner, farm, reward, farmAddr, actors, owned } = await setup();
      await openWindow(farm, reward, owner, farmAddr, E("30000000"), TEN_YEARS);
      await time.increase(100 * DAY);
      await farm.connect(actors[0]).stake([owned.get(actors[0].address)[0]]);

      await farm.connect(owner).setStakingPaused(true);
      await expect(farm.connect(owner).addToDrip(await farm.unallocatedRewards())).to.not.be.reverted;

      await time.increase(DAY);
      expect(await farm.earned(actors[0].address)).to.be.gt(0);
      await expect(farm.connect(actors[0]).exit()).to.not.be.reverted;
    });

    it("survives a reward-token swap afterwards without leaking value", async function () {
      const { owner, farm, reward, farmAddr, actors, owned } = await setup();
      await openWindow(farm, reward, owner, farmAddr, E("30000000"), TEN_YEARS);
      await time.increase(200 * DAY);
      await farm.connect(actors[0]).stake([owned.get(actors[0].address)[0]]);
      await farm.connect(owner).addToDrip(await farm.unallocatedRewards());
      await time.increase(10 * DAY);

      // Everyone out, drip closed — the only state setRewardsToken allows.
      await farm.connect(actors[0]).exit();
      await farm.connect(owner).cancelDrip();

      const Reward2 = await ethers.getContractFactory("MockRewardToken");
      const reward2 = await Reward2.deploy(
        "Second", "TRW2", owner.address, E("1000000"), owner.address, owner.address
      );
      const ownerBefore = await reward.balanceOf(owner.address);
      await farm.connect(owner).setRewardsToken(await reward2.getAddress());

      // The whole old-token balance came back to the owner; nothing stuck.
      expect(await reward.balanceOf(farmAddr)).to.equal(0);
      expect(await reward.balanceOf(owner.address)).to.be.gt(ownerBefore);
      expect(await farm.rewardEpoch()).to.equal(2);
    });
  });

  // =========================================================================
  describe("Griefing and access", function () {
    it("no non-owner can call it, whatever they hold", async function () {
      const { owner, farm, reward, farmAddr, actors, owned } = await setup();
      await openWindow(farm, reward, owner, farmAddr, E("30000000"), TEN_YEARS);
      await time.increase(100 * DAY);
      await farm.connect(actors[0]).stake([owned.get(actors[0].address)[0]]);

      const surplus = await farm.unallocatedRewards();
      for (const a of actors) {
        await expect(farm.connect(a).addToDrip(surplus)).to.be.revertedWithCustomError(
          farm, "OwnableUnauthorizedAccount"
        );
      }
    });

    it("repeated top-ups in consecutive blocks cannot drain or double-count", async function () {
      const { owner, farm, reward, farmAddr, actors, owned } = await setup();
      await openWindow(farm, reward, owner, farmAddr, E("30000000"), TEN_YEARS);
      await time.increase(400 * DAY);
      await farm.connect(actors[0]).stake([owned.get(actors[0].address)[0]]);

      const finish = await farm.periodFinish();
      for (let i = 0; i < 10; i++) {
        const surplus = await farm.unallocatedRewards();
        const remaining = finish - BigInt(await time.latest());
        if (surplus === 0n || surplus / remaining === 0n) break;
        await farm.connect(owner).addToDrip(surplus);

        const balance = await farm.rewardBalance();
        expect(balance).to.be.gte((await farm.outstandingRewards()) + (await farm.scheduledRewards()));
      }
      expect(await farm.periodFinish()).to.equal(finish);
      // Surplus is consumed, not regenerated by the calls themselves.
      expect(await farm.unallocatedRewards()).to.be.lt(E("1"));
    });

    it("a staker cannot front-run a top-up to capture accrual they were not there for", async function () {
      const { owner, farm, reward, farmAddr, actors, owned } = await setup({ actorCount: 2 });
      const [alice, bob] = actors;
      await openWindow(farm, reward, owner, farmAddr, E("30000000"), TEN_YEARS);
      await time.increase(300 * DAY); // long empty stretch builds the surplus

      // Bob stakes the instant before the top-up lands.
      await farm.connect(bob).stake([owned.get(bob.address)[0]]);
      await farm.connect(owner).addToDrip(await farm.unallocatedRewards());

      // He owns none of the 300 idle days — the surplus is streamed forward,
      // never handed out as a lump.
      expect(await farm.earned(bob.address)).to.be.lt(E("1"));
    });
  });
});
