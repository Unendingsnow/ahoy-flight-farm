const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const WEEK = 7 * DAY;
const E = ethers.parseEther;

/**
 * The live reward token taxes buys and sells 1% burn / 1% omega / 1% treasury.
 * These tests pin the tax mechanics down and then prove the farm stays exactly
 * solvent against it — both in the intended setup (farm tax-exempt) and in the
 * worst case where the farm is NOT exempt and every transfer is taxed.
 */
describe("Taxed reward token (1% burn / 1% omega / 1% treasury)", function () {
  async function fixture() {
    const [owner, alice, bob, omega, treasury, pair] = await ethers.getSigners();

    const Reward = await ethers.getContractFactory("MockRewardToken");
    const reward = await Reward.deploy(
      "Test Reward",
      "TRWD",
      owner.address,
      E("100000000"),
      omega.address,
      treasury.address
    );
    const rewardAddr = await reward.getAddress();
    await reward.setAmmPair(pair.address, true);

    const Mock = await ethers.getContractFactory("MockNftCollection");
    const nft = await Mock.deploy(E("10000"));
    const nftAddr = await nft.getAddress();

    const Farm = await ethers.getContractFactory("NftStakeFarm");
    const farm = await Farm.deploy(owner.address, rewardAddr, nftAddr);
    const farmAddr = await farm.getAddress();

    await nft.setWhitelist(farmAddr, true);
    await nft.transfer(alice.address, E("5"));
    await nft.transfer(bob.address, E("5"));
    await nft.connect(alice).setApprovalForAll(farmAddr, true);
    await nft.connect(bob).setApprovalForAll(farmAddr, true);

    return {
      owner, alice, bob, omega, treasury, pair,
      reward, rewardAddr, nft, nftAddr, farm, farmAddr,
      aliceIds: await nft.ownedIds(alice.address),
      bobIds: await nft.ownedIds(bob.address),
    };
  }

  async function startDrip(farm, reward, owner, amount, duration) {
    await farm.connect(owner).setRewardsDuration(duration);
    await reward.connect(owner).approve(await farm.getAddress(), amount);
    await farm.connect(owner).fund(amount);
    await farm.connect(owner).notifyRewardAmount(await farm.unallocatedRewards());
  }

  describe("Tokenomics", function () {
    it("takes 3% on a sell (transfer TO a pair): 1/1/1", async function () {
      const { reward, owner, alice, omega, treasury, pair } = await fixture();
      await reward.transfer(alice.address, E("1000")); // owner is exempt -> clean
      expect(await reward.balanceOf(alice.address)).to.equal(E("1000"));

      const supplyBefore = await reward.totalSupply();
      const omegaBefore = await reward.balanceOf(omega.address);
      const treasBefore = await reward.balanceOf(treasury.address);

      await reward.connect(alice).transfer(pair.address, E("100"));

      expect(await reward.balanceOf(pair.address)).to.equal(E("97"));
      expect(supplyBefore - (await reward.totalSupply())).to.equal(E("1")); // burned
      expect((await reward.balanceOf(omega.address)) - omegaBefore).to.equal(E("1"));
      expect((await reward.balanceOf(treasury.address)) - treasBefore).to.equal(E("1"));
      expect(await reward.balanceOf(alice.address)).to.equal(E("900"));
    });

    it("takes 3% on a buy (transfer FROM a pair)", async function () {
      const { reward, owner, alice, pair } = await fixture();
      await reward.transfer(pair.address, E("1000"));
      await reward.connect(pair).transfer(alice.address, E("100"));
      expect(await reward.balanceOf(alice.address)).to.equal(E("97"));
    });

    it("does not tax wallet-to-wallet transfers", async function () {
      const { reward, alice, bob } = await fixture();
      await reward.transfer(alice.address, E("100"));
      await reward.connect(alice).transfer(bob.address, E("50"));
      expect(await reward.balanceOf(bob.address)).to.equal(E("50"));
      expect(await reward.balanceOf(alice.address)).to.equal(E("50"));
    });

    it("does not tax an exempt counterparty even on a pair trade", async function () {
      const { reward, alice, pair } = await fixture();
      await reward.setTaxExempt(alice.address, true);
      await reward.transfer(alice.address, E("100"));
      await reward.connect(alice).transfer(pair.address, E("100"));
      expect(await reward.balanceOf(pair.address)).to.equal(E("100"));
    });

    it("quoteTax matches what actually happens", async function () {
      const { reward, alice, pair } = await fixture();
      await reward.transfer(alice.address, E("777"));
      const q = await reward.quoteTax(alice.address, pair.address, E("777"));
      await reward.connect(alice).transfer(pair.address, E("777"));
      expect(await reward.balanceOf(pair.address)).to.equal(q.net);
      expect(q.burnAmt + q.omegaAmt + q.treasuryAmt + q.net).to.equal(E("777"));
    });

    it("caps total tax at 10% and is owner-only", async function () {
      const { reward, alice } = await fixture();
      await expect(reward.setTaxes(400, 400, 400)).to.be.revertedWith("tax too high");
      await expect(reward.setTaxes(200, 200, 200)).to.not.be.reverted;
      expect(await reward.totalTaxBps()).to.equal(600);
      await expect(reward.connect(alice).setTaxes(0, 0, 0)).to.be.revertedWithCustomError(
        reward,
        "OwnableUnauthorizedAccount"
      );
    });

    it("zero tax disables the fee entirely", async function () {
      const { reward, alice, pair } = await fixture();
      await reward.setTaxes(0, 0, 0);
      await reward.transfer(alice.address, E("100"));
      await reward.connect(alice).transfer(pair.address, E("100"));
      expect(await reward.balanceOf(pair.address)).to.equal(E("100"));
    });
  });

  describe("Farm exempted (the intended live setup)", function () {
    it("funds and pays out untaxed, end to end", async function () {
      const { farm, farmAddr, reward, owner, alice, aliceIds } = await fixture();
      await reward.setTaxExempt(farmAddr, true);
      await farm.connect(alice).stake([aliceIds[0]]);

      const budget = E("70000");
      await startDrip(farm, reward, owner, budget, WEEK);
      expect(await farm.rewardBalance()).to.equal(budget);

      await time.increase(WEEK + 10);
      await farm.connect(alice).getReward();
      // Farm -> alice is exempt on the farm's side, so she gets the full amount.
      expect(await reward.balanceOf(alice.address)).to.be.closeTo(budget, E("1"));
      expect(await farm.rewardBalance()).to.be.lt(E("1"));
    });

    it("survives an exempt farm even when taxAllTransfers is on", async function () {
      const { farm, farmAddr, reward, owner, alice, aliceIds } = await fixture();
      await reward.setTaxExempt(farmAddr, true);
      await reward.setTaxAllTransfers(true);
      await farm.connect(alice).stake([aliceIds[0]]);

      const budget = E("70000");
      await startDrip(farm, reward, owner, budget, WEEK);
      await time.increase(WEEK + 10);
      await farm.connect(alice).getReward();
      expect(await reward.balanceOf(alice.address)).to.be.closeTo(budget, E("1"));
    });
  });

  describe("Farm NOT exempt — worst case, every transfer taxed", function () {
    it("fund() credits only what actually arrived", async function () {
      const { farm, farmAddr, reward, owner } = await fixture();
      await reward.setTaxAllTransfers(true);
      await reward.setTaxExempt(owner.address, false); // owner loses its exemption too

      await reward.connect(owner).approve(farmAddr, E("1000"));
      await expect(farm.connect(owner).fund(E("1000")))
        .to.emit(farm, "Funded")
        .withArgs(owner.address, E("970"));

      expect(await farm.rewardBalance()).to.equal(E("970"));
      expect(await farm.unallocatedRewards()).to.equal(E("970"));
    });

    it("never over-commits: the drip is sized off the balance that arrived", async function () {
      const { farm, farmAddr, reward, owner, alice, aliceIds } = await fixture();
      await reward.setTaxAllTransfers(true);
      await reward.setTaxExempt(owner.address, false);
      await farm.connect(alice).stake([aliceIds[0]]);

      await farm.connect(owner).setRewardsDuration(WEEK);
      await reward.connect(owner).approve(farmAddr, E("100000"));
      await farm.connect(owner).fund(E("100000")); // 97,000 lands

      // Notifying the pre-tax figure must be rejected outright.
      await expect(farm.connect(owner).notifyRewardAmount(E("100000"))).to.be.revertedWith(
        "Provided reward too high"
      );
      // The post-tax figure is exactly right.
      await expect(farm.connect(owner).notifyRewardAmount(E("97000"))).to.not.be.reverted;
      expect(await farm.rewardRate()).to.equal(E("97000") / BigInt(WEEK));
    });

    it("stakers receive the post-tax amount and the farm stays exactly solvent", async function () {
      const { farm, farmAddr, reward, owner, alice, bob, aliceIds, bobIds } = await fixture();
      await reward.setTaxAllTransfers(true);
      await reward.setTaxExempt(owner.address, false);

      await farm.connect(alice).stake([aliceIds[0], aliceIds[1]]);
      await farm.connect(bob).stake([bobIds[0]]);

      await farm.connect(owner).setRewardsDuration(WEEK);
      await reward.connect(owner).approve(farmAddr, E("100000"));
      await farm.connect(owner).fund(E("100000"));
      const landed = await farm.rewardBalance(); // 97,000
      await farm.connect(owner).notifyRewardAmount(landed);

      await time.increase(WEEK + 10);

      const aliceOwed = await farm.earned(alice.address);
      const bobOwed = await farm.earned(bob.address);
      expect(aliceOwed).to.be.closeTo((landed * 2n) / 3n, E("1"));
      expect(bobOwed).to.be.closeTo(landed / 3n, E("1"));

      await farm.connect(alice).getReward();
      await farm.connect(bob).getReward();

      // Each receives 97% of what they earned — the token's tax, not a farm bug.
      expect(await reward.balanceOf(alice.address)).to.equal((aliceOwed * 9700n) / 10000n);
      expect(await reward.balanceOf(bob.address)).to.equal((bobOwed * 9700n) / 10000n);

      // The farm debited exactly what it owed: no shortfall, no trapped surplus.
      expect(await farm.rewardBalance()).to.be.lt(E("1"));
      expect(await farm.outstandingRewards()).to.equal(0);
    });

    it("the last staker out can still be paid in full (no insolvency)", async function () {
      const { farm, farmAddr, reward, owner, alice, bob, aliceIds, bobIds } = await fixture();
      await reward.setTaxAllTransfers(true);
      await reward.setTaxExempt(owner.address, false);

      await farm.connect(alice).stake([aliceIds[0]]);
      await farm.connect(bob).stake([bobIds[0]]);
      await farm.connect(owner).setRewardsDuration(WEEK);
      await reward.connect(owner).approve(farmAddr, E("100000"));
      await farm.connect(owner).fund(E("100000"));
      await farm.connect(owner).notifyRewardAmount(await farm.unallocatedRewards());

      await time.increase(WEEK + 10);
      await farm.connect(alice).exit();
      // bob claims last, when the farm is nearly drained — must not revert
      await expect(farm.connect(bob).exit()).to.not.be.reverted;
      expect(await reward.balanceOf(bob.address)).to.be.gt(0);
    });
  });

  describe("Deflation does not break the farm", function () {
    it("burning supply elsewhere leaves the farm's reserve and drip intact", async function () {
      const { farm, farmAddr, reward, owner, alice, bob, aliceIds, pair } = await fixture();
      await reward.setTaxExempt(farmAddr, true);
      await farm.connect(alice).stake([aliceIds[0]]);
      const budget = E("70000");
      await startDrip(farm, reward, owner, budget, WEEK);

      // Heavy trading burns a chunk of total supply outside the farm.
      await reward.transfer(bob.address, E("1000000"));
      const supplyBefore = await reward.totalSupply();
      await reward.connect(bob).transfer(pair.address, E("1000000"));
      expect(supplyBefore - (await reward.totalSupply())).to.equal(E("10000"));

      await time.increase(WEEK + 10);
      expect(await farm.rewardBalance()).to.equal(budget);
      expect(await farm.earned(alice.address)).to.be.closeTo(budget, E("1"));
      await expect(farm.connect(alice).getReward()).to.not.be.reverted;
    });
  });
});
