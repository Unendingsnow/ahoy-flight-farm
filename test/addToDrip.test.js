const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const TEN_YEARS = 3650 * DAY;
const ZERO = ethers.ZeroAddress;

/**
 * `addToDrip` recycles surplus reward into the RUNNING window without moving
 * the end date — the thing `notifyRewardAmount` cannot do, because it always
 * restarts a full `rewardsDuration` from the moment it is called.
 *
 * The surplus these tests are about is real: emissions run against the clock,
 * so any stretch with nothing staked accrues to nobody and settles into
 * `unallocatedRewards()`.
 */
describe("NftStakeFarm — addToDrip (recycle surplus, keep the end date)", function () {
  async function fixture() {
    const [owner, alice, bob, carol] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockNftCollection");
    const nft = await Mock.deploy(ethers.parseEther("10000"));
    const nftAddr = await nft.getAddress();

    const Reward = await ethers.getContractFactory("MockRewardToken");
    const reward = await Reward.deploy(
      "Test Reward",
      "TRWD",
      owner.address,
      ethers.parseEther("100000000"),
      carol.address,
      owner.address
    );
    const rewardAddr = await reward.getAddress();

    const Farm = await ethers.getContractFactory("NftStakeFarm");
    const farm = await Farm.deploy(owner.address, ZERO, ZERO);
    const farmAddr = await farm.getAddress();

    await farm.connect(owner).setStakingToken(nftAddr);
    await farm.connect(owner).setRewardsToken(rewardAddr);
    await nft.setWhitelist(farmAddr, true);
    await reward.setTaxExempt(farmAddr, true);

    await nft.transfer(alice.address, ethers.parseEther("5"));
    await nft.transfer(bob.address, ethers.parseEther("5"));
    await nft.connect(alice).setApprovalForAll(farmAddr, true);
    await nft.connect(bob).setApprovalForAll(farmAddr, true);

    return {
      owner, alice, bob, nft, nftAddr, reward, rewardAddr, farm, farmAddr,
      aliceIds: await nft.ownedIds(alice.address),
      bobIds: await nft.ownedIds(bob.address),
    };
  }

  /** Fund `amount` and stream it over `duration`, exactly as the panel does. */
  async function startDrip(farm, reward, owner, amount, duration) {
    await farm.connect(owner).setRewardsDuration(duration);
    await reward.connect(owner).approve(await farm.getAddress(), amount);
    await farm.connect(owner).fund(amount);
    await farm.connect(owner).notifyRewardAmount(amount);
  }

  /** Run the farm empty for `seconds`, which is what mints a surplus. */
  async function idleEmpty(seconds) {
    await time.increase(seconds);
  }

  describe("The surplus it exists to recycle", function () {
    it("time with nothing staked accrues to nobody and becomes unallocated", async function () {
      const { farm, reward, owner } = await fixture();
      await startDrip(farm, reward, owner, ethers.parseEther("30000000"), TEN_YEARS);

      const rate = await farm.rewardRate();
      // Not zero: `reward / rewardsDuration` truncates, so a few hundred million
      // wei of per-second dust is unallocated from the very first block.
      const dust = await farm.unallocatedRewards();
      expect(dust).to.be.lt(ethers.parseEther("0.000001"));

      await idleEmpty(30 * DAY);

      // Nobody earned a thing over that month...
      expect(await farm.outstandingRewards()).to.equal(0);
      expect(await farm.totalDistributed()).to.equal(0);
      // ...and the month's emissions settled into the surplus instead.
      const grown = (await farm.unallocatedRewards()) - dust;
      expect(grown).to.be.closeTo(rate * BigInt(30 * DAY), rate * 5n);
    });

    it("unallocated grows only while empty, and holds steady once staked", async function () {
      const { farm, reward, owner, alice, aliceIds } = await fixture();
      await startDrip(farm, reward, owner, ethers.parseEther("30000000"), TEN_YEARS);

      await idleEmpty(10 * DAY);
      const afterEmpty = await farm.unallocatedRewards();
      expect(afterEmpty).to.be.gt(0);

      await farm.connect(alice).stake([aliceIds[0]]);
      await time.increase(10 * DAY);
      const afterStaked = await farm.unallocatedRewards();

      // Once someone is staked, outstanding grows exactly as scheduled shrinks,
      // so the surplus stops moving (bar per-second truncation dust).
      const drift = afterStaked > afterEmpty ? afterStaked - afterEmpty : afterEmpty - afterStaked;
      expect(drift).to.be.lt(ethers.parseEther("1"));
    });
  });

  describe("Recycling without moving the end date", function () {
    it("keeps periodFinish exactly where it was and raises the rate", async function () {
      const { farm, reward, owner, alice, aliceIds } = await fixture();
      await startDrip(farm, reward, owner, ethers.parseEther("30000000"), TEN_YEARS);

      await idleEmpty(60 * DAY);
      await farm.connect(alice).stake([aliceIds[0]]);

      const finishBefore = await farm.periodFinish();
      const rateBefore = await farm.rewardRate();
      const surplus = await farm.unallocatedRewards();
      expect(surplus).to.be.gt(0);

      await farm.connect(owner).addToDrip(surplus);

      expect(await farm.periodFinish()).to.equal(finishBefore, "end date must not move");
      expect(await farm.rewardRate()).to.be.gt(rateBefore, "rate must rise");
    });

    it("raises the rate by exactly amount / remaining", async function () {
      const { farm, reward, owner, alice, aliceIds } = await fixture();
      await startDrip(farm, reward, owner, ethers.parseEther("30000000"), TEN_YEARS);

      await idleEmpty(45 * DAY);
      await farm.connect(alice).stake([aliceIds[0]]);

      const rateBefore = await farm.rewardRate();
      const surplus = await farm.unallocatedRewards();
      const finish = await farm.periodFinish();

      const tx = await farm.connect(owner).addToDrip(surplus);
      const receipt = await tx.wait();
      const at = BigInt((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);

      const remaining = finish - at;
      expect(await farm.rewardRate()).to.equal(rateBefore + surplus / remaining);
    });

    it("contrast: notifyRewardAmount pushes the end date out instead", async function () {
      const { farm, reward, owner, alice, aliceIds } = await fixture();
      await startDrip(farm, reward, owner, ethers.parseEther("30000000"), TEN_YEARS);

      await idleEmpty(60 * DAY);
      await farm.connect(alice).stake([aliceIds[0]]);

      const finishBefore = await farm.periodFinish();
      await farm.connect(owner).notifyRewardAmount(await farm.unallocatedRewards());

      // ~60 days of drift, because the window restarts from now.
      expect(await farm.periodFinish()).to.be.gt(finishBefore + BigInt(59 * DAY));
    });

    it("pays the higher rate out for real, and only from the top-up onward", async function () {
      const { farm, reward, owner, alice, aliceIds } = await fixture();
      await startDrip(farm, reward, owner, ethers.parseEther("30000000"), TEN_YEARS);

      await idleEmpty(90 * DAY);
      await farm.connect(alice).stake([aliceIds[0]]);

      await time.increase(DAY);
      const earnedBefore = await farm.earned(alice.address);
      const rateBefore = await farm.rewardRate();

      await farm.connect(owner).addToDrip(await farm.unallocatedRewards());
      const atTopUp = await farm.earned(alice.address);

      await time.increase(DAY);
      const earnedAfter = await farm.earned(alice.address);

      const dayAtOldRate = earnedBefore;
      const dayAtNewRate = earnedAfter - atTopUp;
      expect(dayAtNewRate).to.be.gt(dayAtOldRate, "the day after pays more than the day before");

      // Nothing retroactive: accrual is checkpointed at the OLD rate, so the two
      // reads differ only by the second the top-up transaction itself mined.
      expect(atTopUp - earnedBefore).to.be.lte(rateBefore * 3n);
    });

    it("stays solvent — the farm can still pay everything it now owes", async function () {
      const { farm, reward, owner, alice, bob, aliceIds, bobIds } = await fixture();
      await startDrip(farm, reward, owner, ethers.parseEther("30000000"), TEN_YEARS);

      await idleEmpty(120 * DAY);
      await farm.connect(alice).stake([aliceIds[0]]);
      await farm.connect(bob).stake([bobIds[0]]);
      await farm.connect(owner).addToDrip(await farm.unallocatedRewards());

      await time.increase(365 * DAY);

      const balance = await reward.balanceOf(await farm.getAddress());
      const committed = (await farm.outstandingRewards()) + (await farm.scheduledRewards());
      expect(balance).to.be.gte(committed, "balance must cover outstanding + scheduled");

      // And a real claim goes through.
      await expect(farm.connect(alice).getReward()).to.not.be.reverted;
      expect(await reward.balanceOf(alice.address)).to.be.gt(0);
    });

    it("drains the surplus it recycles", async function () {
      const { farm, reward, owner, alice, aliceIds } = await fixture();
      await startDrip(farm, reward, owner, ethers.parseEther("30000000"), TEN_YEARS);

      await idleEmpty(30 * DAY);
      await farm.connect(alice).stake([aliceIds[0]]);

      const surplus = await farm.unallocatedRewards();
      await farm.connect(owner).addToDrip(surplus);

      // Only per-second truncation dust survives.
      expect(await farm.unallocatedRewards()).to.be.lt(ethers.parseEther("1"));
    });

    it("emits DripToppedUp with the unchanged periodFinish", async function () {
      const { farm, reward, owner, alice, aliceIds } = await fixture();
      await startDrip(farm, reward, owner, ethers.parseEther("30000000"), TEN_YEARS);
      await idleEmpty(30 * DAY);
      await farm.connect(alice).stake([aliceIds[0]]);

      const finish = await farm.periodFinish();
      const surplus = await farm.unallocatedRewards();

      await farm.connect(owner).addToDrip(surplus);
      const rateAfter = await farm.rewardRate();

      const [log] = await farm.queryFilter(farm.filters.DripToppedUp());
      expect(log.args.amount).to.equal(surplus);
      expect(log.args.rewardRate).to.equal(rateAfter);
      expect(log.args.periodFinish).to.equal(finish);
    });
  });

  describe("Guards", function () {
    it("only the owner can call it", async function () {
      const { farm, reward, owner, alice, aliceIds } = await fixture();
      await startDrip(farm, reward, owner, ethers.parseEther("30000000"), TEN_YEARS);
      await idleEmpty(30 * DAY);
      await farm.connect(alice).stake([aliceIds[0]]);

      await expect(
        farm.connect(alice).addToDrip(await farm.unallocatedRewards())
      ).to.be.revertedWithCustomError(farm, "OwnableUnauthorizedAccount");
    });

    it("refuses more than the unallocated surplus", async function () {
      const { farm, reward, owner, alice, aliceIds } = await fixture();
      await startDrip(farm, reward, owner, ethers.parseEther("30000000"), TEN_YEARS);
      await idleEmpty(30 * DAY);
      await farm.connect(alice).stake([aliceIds[0]]);

      const surplus = await farm.unallocatedRewards();
      await expect(
        farm.connect(owner).addToDrip(surplus + ethers.parseEther("1000"))
      ).to.be.revertedWith("Exceeds unallocated rewards");
    });

    it("cannot touch rewards already earned by stakers", async function () {
      const { farm, reward, owner, alice, aliceIds } = await fixture();
      await startDrip(farm, reward, owner, ethers.parseEther("30000000"), TEN_YEARS);

      await farm.connect(alice).stake([aliceIds[0]]);
      await time.increase(30 * DAY);
      const owed = await farm.outstandingRewards();
      expect(owed).to.be.gt(0);

      // Nothing was ever idle, so there is no surplus to recycle at all.
      expect(await farm.unallocatedRewards()).to.be.lt(ethers.parseEther("1"));
      await expect(farm.connect(owner).addToDrip(owed)).to.be.revertedWith(
        "Exceeds unallocated rewards"
      );
    });

    it("refuses zero", async function () {
      const { farm, reward, owner } = await fixture();
      await startDrip(farm, reward, owner, ethers.parseEther("30000000"), TEN_YEARS);
      await expect(farm.connect(owner).addToDrip(0)).to.be.revertedWith("Nothing to add");
    });

    it("refuses once the window is over — use notifyRewardAmount to reopen", async function () {
      const { farm, reward, owner } = await fixture();
      await startDrip(farm, reward, owner, ethers.parseEther("1000000"), 30 * DAY);

      await time.increase(31 * DAY);
      const surplus = await farm.unallocatedRewards();
      expect(surplus).to.be.gt(0);
      await expect(farm.connect(owner).addToDrip(surplus)).to.be.revertedWith("No active window");
    });

    it("refuses after cancelDrip, which closes the window", async function () {
      const { farm, reward, owner, alice, aliceIds } = await fixture();
      await startDrip(farm, reward, owner, ethers.parseEther("30000000"), TEN_YEARS);
      await farm.connect(alice).stake([aliceIds[0]]);
      await time.increase(30 * DAY);

      await farm.connect(owner).cancelDrip();
      await expect(
        farm.connect(owner).addToDrip(await farm.unallocatedRewards())
      ).to.be.revertedWith("No active window");
    });
  });

  describe("Repeatability", function () {
    it("survives several empty stretches, each recycled in turn", async function () {
      const { farm, reward, owner, alice, aliceIds } = await fixture();
      await startDrip(farm, reward, owner, ethers.parseEther("30000000"), TEN_YEARS);
      const finish = await farm.periodFinish();

      let lastRate = await farm.rewardRate();
      for (let round = 0; round < 3; round++) {
        await idleEmpty(20 * DAY);
        await farm.connect(alice).stake([aliceIds[round]]);
        const surplus = await farm.unallocatedRewards();
        if (surplus > 0n) await farm.connect(owner).addToDrip(surplus);

        const rate = await farm.rewardRate();
        expect(rate).to.be.gte(lastRate);
        lastRate = rate;
        await farm.connect(alice).withdraw([aliceIds[round]]); // go empty again
      }

      expect(await farm.periodFinish()).to.equal(finish, "end date never moved");

      const balance = await reward.balanceOf(await farm.getAddress());
      const committed = (await farm.outstandingRewards()) + (await farm.scheduledRewards());
      expect(balance).to.be.gte(committed, "still solvent after three rounds");
    });
  });
});
