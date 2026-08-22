const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const WEEK = 7 * DAY;
const TEN_YEARS = 3650 * DAY;
const ZERO = ethers.ZeroAddress;

/**
 * The farm is deployed BEFORE the real collection / reward-token addresses are
 * known, then wired up from the admin panel. These tests pin down that flow and
 * every guard that keeps it from stranding an NFT or mis-paying a debt.
 */
describe("NftStakeFarm — late-bound configuration & owner controls", function () {
  async function bareFixture() {
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
      carol.address, // omega
      owner.address // treasury
    );
    const rewardAddr = await reward.getAddress();

    // Deployed completely unconfigured — this is the real launch path.
    const Farm = await ethers.getContractFactory("NftStakeFarm");
    const farm = await Farm.deploy(owner.address, ZERO, ZERO);
    const farmAddr = await farm.getAddress();

    return { owner, alice, bob, carol, nft, nftAddr, reward, rewardAddr, farm, farmAddr };
  }

  // Fully wired farm with alice/bob holding 5 NFTs each.
  async function wiredFixture() {
    const f = await bareFixture();
    const { owner, alice, bob, nft, farm, farmAddr, reward, rewardAddr, nftAddr } = f;

    await farm.connect(owner).setStakingToken(nftAddr);
    await farm.connect(owner).setRewardsToken(rewardAddr);
    await nft.setWhitelist(farmAddr, true);
    await reward.setTaxExempt(farmAddr, true);

    await nft.transfer(alice.address, ethers.parseEther("5"));
    await nft.transfer(bob.address, ethers.parseEther("5"));
    await nft.connect(alice).setApprovalForAll(farmAddr, true);
    await nft.connect(bob).setApprovalForAll(farmAddr, true);

    return {
      ...f,
      aliceIds: await nft.ownedIds(alice.address),
      bobIds: await nft.ownedIds(bob.address),
    };
  }

  async function startDrip(farm, reward, owner, amount, duration) {
    await farm.connect(owner).setRewardsDuration(duration);
    await reward.connect(owner).approve(await farm.getAddress(), amount);
    await farm.connect(owner).fund(amount);
    await farm.connect(owner).notifyRewardAmount(amount);
  }

  describe("Deploying unconfigured", function () {
    it("reports itself unconfigured and refuses stakes", async function () {
      const { farm, alice } = await bareFixture();
      expect(await farm.isConfigured()).to.equal(false);
      expect(await farm.stakingToken()).to.equal(ZERO);
      expect(await farm.rewardsToken()).to.equal(ZERO);
      await expect(farm.connect(alice).stake([1])).to.be.revertedWith("Farm not configured");
    });

    it("has sane zero-state views before anything is wired", async function () {
      const { farm } = await bareFixture();
      expect(await farm.rewardBalance()).to.equal(0);
      expect(await farm.outstandingRewards()).to.equal(0);
      expect(await farm.scheduledRewards()).to.equal(0);
      expect(await farm.unallocatedRewards()).to.equal(0);
      expect(await farm.rewardsDuration()).to.equal(TEN_YEARS);
      expect(await farm.rewardEpoch()).to.equal(1);
    });

    it("refuses to fund or notify before the reward token is set", async function () {
      const { farm, owner } = await bareFixture();
      await expect(farm.connect(owner).fund(1)).to.be.revertedWith("Reward token unset");
      await expect(farm.connect(owner).notifyRewardAmount(1)).to.be.revertedWith("Reward token unset");
    });

    it("becomes configured once both tokens are set", async function () {
      const { farm, owner, nftAddr, rewardAddr } = await bareFixture();
      await expect(farm.connect(owner).setStakingToken(nftAddr))
        .to.emit(farm, "StakingTokenUpdated")
        .withArgs(ZERO, nftAddr);
      expect(await farm.isConfigured()).to.equal(false); // reward token still unset
      await expect(farm.connect(owner).setRewardsToken(rewardAddr))
        .to.emit(farm, "RewardsTokenUpdated")
        .withArgs(ZERO, rewardAddr, 2, 0);
      expect(await farm.isConfigured()).to.equal(true);
    });

    it("only the owner can wire the tokens", async function () {
      const { farm, alice, nftAddr, rewardAddr } = await bareFixture();
      await expect(farm.connect(alice).setStakingToken(nftAddr)).to.be.revertedWithCustomError(
        farm,
        "OwnableUnauthorizedAccount"
      );
      await expect(farm.connect(alice).setRewardsToken(rewardAddr)).to.be.revertedWithCustomError(
        farm,
        "OwnableUnauthorizedAccount"
      );
    });

    it("rejects zero, duplicate and unchanged addresses", async function () {
      const { farm, owner, nftAddr, rewardAddr } = await bareFixture();
      await expect(farm.connect(owner).setStakingToken(ZERO)).to.be.revertedWith("zero token");
      await expect(farm.connect(owner).setRewardsToken(ZERO)).to.be.revertedWith("zero token");

      await farm.connect(owner).setStakingToken(nftAddr);
      await expect(farm.connect(owner).setStakingToken(nftAddr)).to.be.revertedWith("Unchanged");
      // reward token may not be the same contract as the staking token
      await expect(farm.connect(owner).setRewardsToken(nftAddr)).to.be.revertedWith("same token");

      await farm.connect(owner).setRewardsToken(rewardAddr);
      await expect(farm.connect(owner).setStakingToken(rewardAddr)).to.be.revertedWith("same token");
    });

    it("rejects a constructor that points both tokens at one address", async function () {
      const { owner, nftAddr } = await bareFixture();
      const Farm = await ethers.getContractFactory("NftStakeFarm");
      await expect(Farm.deploy(owner.address, nftAddr, nftAddr)).to.be.revertedWith("same token");
    });
  });

  describe("Re-pointing the staking token", function () {
    it("can be swapped while the farm is empty", async function () {
      const { farm, owner, nftAddr, rewardAddr } = await bareFixture();
      await farm.connect(owner).setStakingToken(nftAddr);
      await farm.connect(owner).setRewardsToken(rewardAddr);

      const Mock = await ethers.getContractFactory("MockNftCollection");
      const nft2 = await Mock.deploy(ethers.parseEther("100"));
      const nft2Addr = await nft2.getAddress();

      await expect(farm.connect(owner).setStakingToken(nft2Addr))
        .to.emit(farm, "StakingTokenUpdated")
        .withArgs(nftAddr, nft2Addr);
      expect(await farm.stakingToken()).to.equal(nft2Addr);
    });

    it("CANNOT be swapped while NFTs are staked", async function () {
      const { farm, owner, alice, aliceIds } = await wiredFixture();
      await farm.connect(alice).stake([aliceIds[0]]);

      const Mock = await ethers.getContractFactory("MockNftCollection");
      const nft2 = await Mock.deploy(ethers.parseEther("100"));
      await expect(
        farm.connect(owner).setStakingToken(await nft2.getAddress())
      ).to.be.revertedWith("NFTs still staked");
    });

    it("frees up again once the last NFT leaves", async function () {
      const { farm, owner, alice, aliceIds } = await wiredFixture();
      await farm.connect(alice).stake([aliceIds[0]]);
      await farm.connect(alice).withdraw([aliceIds[0]]);

      const Mock = await ethers.getContractFactory("MockNftCollection");
      const nft2 = await Mock.deploy(ethers.parseEther("100"));
      await expect(farm.connect(owner).setStakingToken(await nft2.getAddress())).to.not.be.reverted;
    });
  });

  describe("Re-pointing the reward token", function () {
    it("CANNOT be swapped while NFTs are staked", async function () {
      const { farm, owner, alice, aliceIds } = await wiredFixture();
      await farm.connect(alice).stake([aliceIds[0]]);
      const BurnTok = await ethers.getContractFactory("MockBurnToken");
      const burnTok = await BurnTok.deploy(owner.address, ethers.parseEther("1000"));
      await expect(
        farm.connect(owner).setRewardsToken(await burnTok.getAddress())
      ).to.be.revertedWith("NFTs still staked");
    });

    it("CANNOT be swapped while a drip is running", async function () {
      const { farm, reward, owner } = await wiredFixture();
      await startDrip(farm, reward, owner, ethers.parseEther("70000"), WEEK);
      const BurnTok = await ethers.getContractFactory("MockBurnToken");
      const burnTok = await BurnTok.deploy(owner.address, ethers.parseEther("1000"));
      await expect(
        farm.connect(owner).setRewardsToken(await burnTok.getAddress())
      ).to.be.revertedWith("Drip running");
    });

    it("returns the old token's leftover balance to the owner", async function () {
      const { farm, reward, owner } = await wiredFixture();
      const budget = ethers.parseEther("70000");
      await startDrip(farm, reward, owner, budget, WEEK);
      await farm.connect(owner).cancelDrip();

      const BurnTok = await ethers.getContractFactory("MockBurnToken");
      const burnTok = await BurnTok.deploy(owner.address, ethers.parseEther("1000"));

      const before = await reward.balanceOf(owner.address);
      await farm.connect(owner).setRewardsToken(await burnTok.getAddress());
      expect((await reward.balanceOf(owner.address)) - before).to.equal(budget);
      expect(await reward.balanceOf(await farm.getAddress())).to.equal(0);
    });

    it("opens a new epoch and drops unclaimed rewards from the old token", async function () {
      const { farm, reward, owner, alice, aliceIds } = await wiredFixture();
      await farm.connect(alice).stake([aliceIds[0]]);
      await startDrip(farm, reward, owner, ethers.parseEther("70000"), WEEK);
      await time.increase(WEEK + 10);

      // Alice pulls her NFT out but never claims — a real, tracked liability.
      await farm.connect(alice).withdraw([aliceIds[0]]);
      const owed = await farm.outstandingRewards();
      expect(owed).to.be.closeTo(ethers.parseEther("70000"), ethers.parseEther("1"));
      expect(await farm.earned(alice.address)).to.equal(owed);

      const BurnTok = await ethers.getContractFactory("MockBurnToken");
      const burnTok = await BurnTok.deploy(owner.address, ethers.parseEther("1000"));
      const burnTokAddr = await burnTok.getAddress();

      await expect(farm.connect(owner).setRewardsToken(burnTokAddr))
        .to.emit(farm, "RewardsTokenUpdated")
        .withArgs(await reward.getAddress(), burnTokAddr, 3, owed);

      // The stale debt is gone — it is NOT repaid out of the new token.
      expect(await farm.rewardEpoch()).to.equal(3);
      expect(await farm.earned(alice.address)).to.equal(0);
      expect(await farm.outstandingRewards()).to.equal(0);

      await farm.connect(alice).getReward();
      expect(await burnTok.balanceOf(alice.address)).to.equal(0);
    });

    it("accrues cleanly again in the new epoch", async function () {
      const { farm, reward, owner, alice, aliceIds } = await wiredFixture();
      await farm.connect(alice).stake([aliceIds[0]]);
      await startDrip(farm, reward, owner, ethers.parseEther("70000"), WEEK);
      await time.increase(WEEK + 10);
      await farm.connect(alice).exit(); // clean settle

      const BurnTok = await ethers.getContractFactory("MockBurnToken");
      const burnTok = await BurnTok.deploy(owner.address, ethers.parseEther("1000000"));
      const burnTokAddr = await burnTok.getAddress();
      await farm.connect(owner).setRewardsToken(burnTokAddr);
      await burnTok.setBurnExempt(await farm.getAddress(), true);

      await farm.connect(alice).stake([aliceIds[0]]);
      await startDrip(farm, burnTok, owner, ethers.parseEther("70000"), WEEK);
      await time.increase(WEEK + 10);

      expect(await farm.earned(alice.address)).to.be.closeTo(
        ethers.parseEther("70000"),
        ethers.parseEther("1")
      );
      await farm.connect(alice).getReward();
      expect(await burnTok.balanceOf(alice.address)).to.be.closeTo(
        ethers.parseEther("70000"),
        ethers.parseEther("1")
      );
    });
  });

  describe("Pause", function () {
    it("blocks new stakes but never withdrawals or claims", async function () {
      const { farm, reward, owner, alice, aliceIds } = await wiredFixture();
      await farm.connect(alice).stake([aliceIds[0], aliceIds[1]]);
      await startDrip(farm, reward, owner, ethers.parseEther("70000"), WEEK);
      await time.increase(WEEK + 10);

      await expect(farm.connect(owner).setStakingPaused(true))
        .to.emit(farm, "StakingPausedUpdated")
        .withArgs(true);

      await expect(farm.connect(alice).stake([aliceIds[2]])).to.be.revertedWith("Staking paused");
      // exits still work in full
      await expect(farm.connect(alice).exit()).to.not.be.reverted;
      expect(await farm.stakedBalanceOf(alice.address)).to.equal(0);
      expect(await reward.balanceOf(alice.address)).to.be.gt(0);

      await farm.connect(owner).setStakingPaused(false);
      await expect(farm.connect(alice).stake([aliceIds[0]])).to.not.be.reverted;
    });

    it("is owner-only", async function () {
      const { farm, alice } = await wiredFixture();
      await expect(farm.connect(alice).setStakingPaused(true)).to.be.revertedWithCustomError(
        farm,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("Funding helpers", function () {
    it("fund() credits the amount actually received and anyone may call it", async function () {
      const { farm, farmAddr, reward, owner, bob } = await wiredFixture();
      await reward.connect(owner).transfer(bob.address, ethers.parseEther("1000"));
      await reward.connect(bob).approve(farmAddr, ethers.parseEther("1000"));
      await expect(farm.connect(bob).fund(ethers.parseEther("1000")))
        .to.emit(farm, "Funded")
        .withArgs(bob.address, ethers.parseEther("1000"));
      expect(await farm.rewardBalance()).to.equal(ethers.parseEther("1000"));
      expect(await farm.unallocatedRewards()).to.equal(ethers.parseEther("1000"));
    });

    it("fund(0) reverts", async function () {
      const { farm, owner } = await wiredFixture();
      await expect(farm.connect(owner).fund(0)).to.be.revertedWith("Cannot fund 0");
    });

    it("fundAndStart() funds and streams the whole unallocated balance", async function () {
      const { farm, farmAddr, reward, owner, alice, aliceIds } = await wiredFixture();
      await farm.connect(alice).stake([aliceIds[0]]);
      await farm.connect(owner).setRewardsDuration(WEEK);

      const budget = ethers.parseEther("70000");
      await reward.connect(owner).approve(farmAddr, budget);
      await expect(farm.connect(owner).fundAndStart(budget)).to.emit(farm, "RewardAdded");

      expect(await farm.rewardRate()).to.equal(budget / BigInt(WEEK));
      await time.increase(WEEK + 10);
      expect(await farm.earned(alice.address)).to.be.closeTo(budget, ethers.parseEther("1"));
    });

    it("fundAndStart() is owner-only", async function () {
      const { farm, alice } = await wiredFixture();
      await expect(farm.connect(alice).fundAndStart(1)).to.be.revertedWithCustomError(
        farm,
        "OwnableUnauthorizedAccount"
      );
    });

    it("notifyRewardAmount cannot over-commit rewards already owed to stakers", async function () {
      const { farm, farmAddr, reward, owner, alice, aliceIds } = await wiredFixture();
      await farm.connect(alice).stake([aliceIds[0]]);
      const budget = ethers.parseEther("70000");
      await startDrip(farm, reward, owner, budget, WEEK);
      await time.increase(WEEK + 10);

      // Whole budget is now owed to alice, but still physically in the farm.
      expect(await farm.rewardBalance()).to.equal(budget);
      expect(await farm.outstandingRewards()).to.be.closeTo(budget, ethers.parseEther("1"));
      expect(await farm.unallocatedRewards()).to.be.lt(ethers.parseEther("1"));

      // Re-notifying that same balance must fail: it isn't the farm's to stream.
      await expect(farm.connect(owner).notifyRewardAmount(budget)).to.be.revertedWith(
        "Provided reward too high"
      );

      // And alice can still be paid in full.
      await farm.connect(alice).getReward();
      expect(await reward.balanceOf(alice.address)).to.be.closeTo(budget, ethers.parseEther("1"));
    });

    it("rejects a zero notify and a sub-wei-per-second rate", async function () {
      const { farm, farmAddr, reward, owner } = await wiredFixture();
      await expect(farm.connect(owner).notifyRewardAmount(0)).to.be.revertedWith("Nothing to stream");

      await reward.connect(owner).approve(farmAddr, 100);
      await farm.connect(owner).fund(100);
      // 100 wei over 10 years rounds the rate down to zero
      await expect(farm.connect(owner).notifyRewardAmount(100)).to.be.revertedWith("Reward rate = 0");
    });
  });

  describe("cancelDrip", function () {
    it("stops accrual, keeps earned rewards owed, frees the remainder", async function () {
      const { farm, reward, owner, alice, aliceIds } = await wiredFixture();
      await farm.connect(alice).stake([aliceIds[0]]);
      const budget = ethers.parseEther("70000"); // over a week
      await startDrip(farm, reward, owner, budget, WEEK);

      await time.increase(DAY);
      await expect(farm.connect(owner).cancelDrip()).to.emit(farm, "DripCancelled");

      const earnedAtCancel = await farm.earned(alice.address);
      expect(earnedAtCancel).to.be.closeTo(ethers.parseEther("10000"), ethers.parseEther("50"));

      // No further accrual after the cancel.
      await time.increase(3 * DAY);
      expect(await farm.earned(alice.address)).to.equal(earnedAtCancel);
      expect(await farm.rewardRate()).to.equal(0);
      expect(await farm.scheduledRewards()).to.equal(0);

      // ~60k is freed up for the owner; alice's ~10k is still protected.
      expect(await farm.unallocatedRewards()).to.be.closeTo(
        ethers.parseEther("60000"),
        ethers.parseEther("50")
      );
      expect(await farm.outstandingRewards()).to.equal(earnedAtCancel);

      await farm.connect(alice).getReward();
      expect(await reward.balanceOf(alice.address)).to.equal(earnedAtCancel);
    });

    it("is owner-only", async function () {
      const { farm, alice } = await wiredFixture();
      await expect(farm.connect(alice).cancelDrip()).to.be.revertedWithCustomError(
        farm,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("Rescue guards", function () {
    it("cannot recover reward tokens that stakers have already earned", async function () {
      const { farm, reward, owner, alice, aliceIds } = await wiredFixture();
      await farm.connect(alice).stake([aliceIds[0]]);
      const budget = ethers.parseEther("70000");
      await startDrip(farm, reward, owner, budget, WEEK);
      await time.increase(WEEK + 10);

      await expect(
        farm.connect(owner).recoverERC20(await reward.getAddress(), budget)
      ).to.be.revertedWith("Exceeds unallocated rewards");
    });

    it("cannot recover reward tokens still scheduled for the current window", async function () {
      const { farm, reward, owner, alice, aliceIds } = await wiredFixture();
      await farm.connect(alice).stake([aliceIds[0]]);
      await startDrip(farm, reward, owner, ethers.parseEther("70000"), WEEK);
      await expect(
        farm.connect(owner).recoverERC20(await reward.getAddress(), ethers.parseEther("1000"))
      ).to.be.revertedWith("Exceeds unallocated rewards");
    });

    it("can recover the unallocated surplus", async function () {
      const { farm, farmAddr, reward, owner } = await wiredFixture();
      const extra = ethers.parseEther("500");
      await reward.connect(owner).transfer(farmAddr, extra); // stray, never notified
      expect(await farm.unallocatedRewards()).to.equal(extra);

      const before = await reward.balanceOf(owner.address);
      await farm.connect(owner).recoverERC20(await reward.getAddress(), extra);
      expect((await reward.balanceOf(owner.address)) - before).to.equal(extra);
    });

    it("an owner draining every recoverable wei still cannot starve a staker", async function () {
      const { farm, farmAddr, reward, owner, alice, aliceIds } = await wiredFixture();
      await farm.connect(alice).stake([aliceIds[0]]);
      const budget = ethers.parseEther("70000");
      await startDrip(farm, reward, owner, budget, WEEK);

      // Worst case: cancel the drip, then pull out literally everything the
      // contract will let go of.
      await time.increase(2 * DAY);
      await farm.connect(owner).cancelDrip();

      // Read after the cancel — accrual is frozen from here, so this is exact.
      const owed = await farm.earned(alice.address);
      expect(owed).to.be.closeTo(ethers.parseEther("20000"), ethers.parseEther("1"));
      const free = await farm.unallocatedRewards();
      await farm.connect(owner).recoverERC20(await reward.getAddress(), free);
      expect(await farm.unallocatedRewards()).to.equal(0);

      // Alice's earned rewards survived intact and are still payable.
      expect(await farm.earned(alice.address)).to.equal(owed);
      expect(await farm.rewardBalance()).to.be.gte(await farm.outstandingRewards());
      await expect(farm.connect(alice).getReward()).to.not.be.reverted;
      expect(await reward.balanceOf(alice.address)).to.equal(owed);

      // ...and her NFT comes home.
      await farm.connect(alice).withdraw([aliceIds[0]]);
      expect(await farm.totalStaked()).to.equal(0);
    });

    it("recoverERC721 refuses a zero destination", async function () {
      const { farm, owner, nftAddr } = await wiredFixture();
      await expect(farm.connect(owner).recoverERC721(nftAddr, 1, ZERO)).to.be.revertedWith("zero to");
    });

    it("rejects direct safeTransferFrom deposits", async function () {
      const { farm, alice } = await wiredFixture();
      await expect(
        farm.connect(alice).onERC721Received(alice.address, alice.address, 1, "0x")
      ).to.be.revertedWith("Use stake() to deposit");
    });
  });

  describe("Bookkeeping views", function () {
    it("tracks stakerCount as wallets enter and leave", async function () {
      const { farm, alice, bob, aliceIds, bobIds } = await wiredFixture();
      expect(await farm.stakerCount()).to.equal(0);

      await farm.connect(alice).stake([aliceIds[0], aliceIds[1]]);
      expect(await farm.stakerCount()).to.equal(1);
      await farm.connect(alice).stake([aliceIds[2]]); // same wallet, still 1
      expect(await farm.stakerCount()).to.equal(1);

      await farm.connect(bob).stake([bobIds[0]]);
      expect(await farm.stakerCount()).to.equal(2);

      await farm.connect(alice).withdraw([aliceIds[0]]); // partial, still staked
      expect(await farm.stakerCount()).to.equal(2);
      await farm.connect(alice).exit();
      expect(await farm.stakerCount()).to.equal(1);
      await farm.connect(bob).exit();
      expect(await farm.stakerCount()).to.equal(0);
    });

    it("refuses to double-stake a tokenId", async function () {
      const { farm, alice, aliceIds } = await wiredFixture();
      await expect(farm.connect(alice).stake([aliceIds[0], aliceIds[0]])).to.be.revertedWith(
        "Already staked"
      );
    });

    it("farmInfo() mirrors the individual getters", async function () {
      const { farm, reward, owner, nftAddr, rewardAddr, alice, aliceIds } = await wiredFixture();
      await farm.connect(alice).stake([aliceIds[0], aliceIds[1]]);
      await startDrip(farm, reward, owner, ethers.parseEther("70000"), WEEK);

      const info = await farm.farmInfo();
      expect(info.stakingToken_).to.equal(nftAddr);
      expect(info.rewardsToken_).to.equal(rewardAddr);
      expect(info.totalStaked_).to.equal(2);
      expect(info.stakerCount_).to.equal(1);
      expect(info.rewardRate_).to.equal(await farm.rewardRate());
      expect(info.periodFinish_).to.equal(await farm.periodFinish());
      expect(info.rewardsDuration_).to.equal(BigInt(WEEK));
      expect(info.rewardBalance_).to.equal(ethers.parseEther("70000"));
      expect(info.paused_).to.equal(false);
      expect(info.epoch_).to.equal(2);
    });

    it("userInfo() reports the wallet's ids, earnings and share of the stream", async function () {
      const { farm, reward, owner, alice, bob, aliceIds, bobIds } = await wiredFixture();
      await farm.connect(alice).stake([aliceIds[0], aliceIds[1], aliceIds[2]]); // 3 of 4
      await farm.connect(bob).stake([bobIds[0]]);
      await startDrip(farm, reward, owner, ethers.parseEther("70000"), WEEK);
      await time.increase(DAY);

      const rate = await farm.rewardRate();
      const info = await farm.userInfo(alice.address);
      expect(info.staked.length).to.equal(3);
      expect(info.perSecond).to.equal((rate * 3n) / 4n);
      expect(info.earned_).to.be.closeTo(await farm.earned(alice.address), ethers.parseEther("0.01"));

      const empty = await farm.userInfo(bob.address);
      expect(empty.perSecond).to.equal(rate / 4n);
    });

    it("exit() on an empty wallet is a no-op, not a revert", async function () {
      const { farm, carol } = await wiredFixture();
      await expect(farm.connect(carol).exit()).to.not.be.reverted;
    });
  });
});
