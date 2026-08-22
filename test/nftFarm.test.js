const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const WEEK = 7 * DAY;
const TEN_YEARS = 3650 * DAY;

describe("NftStakeFarm (stake NFTs, hard budgeted drip)", function () {
  async function deployFixture() {
    const [owner, alice, bob] = await ethers.getSigners();

    // NFT collection mock. Owner is whitelisted and holds the fungible supply.
    const Mock = await ethers.getContractFactory("MockNftCollection");
    const nft = await Mock.deploy(ethers.parseEther("10000"));
    await nft.waitForDeployment();
    const nftAddr = await nft.getAddress();

    // BURN: full 35M fixed supply minted to the treasury (owner).
    const BurnTok = await ethers.getContractFactory("MockBurnToken");
    const burnTok = await BurnTok.deploy(owner.address, ethers.parseEther("35000000"));
    await burnTok.waitForDeployment();

    const Farm = await ethers.getContractFactory("NftStakeFarm");
    const farm = await Farm.deploy(owner.address, await burnTok.getAddress(), nftAddr);
    await farm.waitForDeployment();
    const farmAddr = await farm.getAddress();

    // Recommended: mark the farm ERC-721 transfer-exempt on the collection.
    await nft.setWhitelist(farmAddr, true);
    // And exempt the farm from BURN's self-burn so payouts aren't taxed.
    await burnTok.setBurnExempt(farmAddr, true);

    // Give alice & bob 5 NFTs each (mints them real NFTs), and approve the farm.
    await nft.transfer(alice.address, ethers.parseEther("5"));
    await nft.transfer(bob.address, ethers.parseEther("5"));
    await nft.connect(alice).setApprovalForAll(farmAddr, true);
    await nft.connect(bob).setApprovalForAll(farmAddr, true);

    const aliceIds = await nft.ownedIds(alice.address);
    const bobIds = await nft.ownedIds(bob.address);

    return { owner, alice, bob, nft, burnTok, farm, farmAddr, aliceIds, bobIds };
  }

  // Fund the farm and start a drip of `amount` BURN over `duration`.
  async function startDrip(farm, burnTok, owner, amount, duration) {
    await farm.connect(owner).setRewardsDuration(duration);
    await burnTok.connect(owner).transfer(await farm.getAddress(), amount);
    await farm.connect(owner).notifyRewardAmount(amount);
  }

  describe("Setup / mock sanity", function () {
    it("gives each staker their own specific NFT tokenIds", async function () {
      const { nft, alice, aliceIds } = await deployFixture();
      expect(aliceIds.length).to.equal(5);
      expect(await nft.ownerOf(aliceIds[0])).to.equal(alice.address);
    });

    it("wires the farm to the reward token and the collection with a 10-year default window", async function () {
      const { farm, burnTok, nft } = await deployFixture();
      expect(await farm.rewardsToken()).to.equal(await burnTok.getAddress());
      expect(await farm.stakingToken()).to.equal(await nft.getAddress());
      expect(await farm.rewardsDuration()).to.equal(TEN_YEARS);
    });
  });

  describe("Staking specific NFTs", function () {
    it("pulls the chosen tokenIds and records the staker", async function () {
      const { farm, farmAddr, nft, alice, aliceIds } = await deployFixture();
      const chosen = [aliceIds[0], aliceIds[2]];

      await expect(farm.connect(alice).stake(chosen))
        .to.emit(farm, "Staked")
        .withArgs(alice.address, chosen);

      expect(await nft.ownerOf(chosen[0])).to.equal(farmAddr);
      expect(await farm.stakerOf(chosen[0])).to.equal(alice.address);
      expect(await farm.stakedBalanceOf(alice.address)).to.equal(2);
      expect(await farm.totalStaked()).to.equal(2);
    });

    it("reverts staking an NFT you don't own / haven't approved", async function () {
      const { farm, bob, aliceIds } = await deployFixture();
      await expect(farm.connect(bob).stake([aliceIds[0]])).to.be.reverted;
    });

    it("reverts on empty stake", async function () {
      const { farm, alice } = await deployFixture();
      await expect(farm.connect(alice).stake([])).to.be.revertedWith("No token ids");
    });
  });

  describe("Hard budgeted drip", function () {
    it("streams (almost) the whole budget to a sole staker over the window", async function () {
      const { farm, burnTok, owner, alice, aliceIds } = await deployFixture();
      // stake first, so the staker is present for the entire window
      await farm.connect(alice).stake([aliceIds[0]]);
      const budget = ethers.parseEther("70000");
      await startDrip(farm, burnTok, owner, budget, WEEK);

      await time.increase(WEEK + 10);
      // sole staker collects the whole budget (minus sub-1-wei-rate dust)
      expect(await farm.earned(alice.address)).to.be.closeTo(budget, ethers.parseEther("1"));
    });

    it("splits the budget across staked NFTs by count (2:1)", async function () {
      const { farm, burnTok, owner, alice, bob, aliceIds, bobIds } = await deployFixture();
      await farm.connect(alice).stake([aliceIds[0], aliceIds[1]]); // 2 NFTs
      await farm.connect(bob).stake([bobIds[0]]); // 1 NFT
      const budget = ethers.parseEther("90000");
      await startDrip(farm, burnTok, owner, budget, WEEK);

      await time.increase(WEEK + 10);
      // 3 shares total: alice 2/3 (60k), bob 1/3 (30k)
      expect(await farm.earned(alice.address)).to.be.closeTo(ethers.parseEther("60000"), ethers.parseEther("1"));
      expect(await farm.earned(bob.address)).to.be.closeTo(ethers.parseEther("30000"), ethers.parseEther("1"));
    });

    it("caps total emission at the budget regardless of how few stake", async function () {
      const { farm, burnTok, owner, alice, aliceIds } = await deployFixture();
      // only ONE NFT of the whole collection is staked -> it still only ever
      // splits the fixed budget; total out == budget, never more.
      await farm.connect(alice).stake([aliceIds[0]]);
      const budget = ethers.parseEther("70000");
      await startDrip(farm, burnTok, owner, budget, WEEK);

      await time.increase(WEEK + 10);
      const earned = await farm.earned(alice.address);
      expect(earned).to.be.lte(budget);
      expect(earned).to.be.closeTo(budget, ethers.parseEther("1"));
    });

    it("matches the real 30M-over-10-years config for a sole staker", async function () {
      const { farm, burnTok, owner, alice, aliceIds } = await deployFixture();
      await farm.connect(alice).stake([aliceIds[0]]);
      const budget = ethers.parseEther("30000000");
      await startDrip(farm, burnTok, owner, budget, TEN_YEARS);

      // full 10 years elapse
      await time.increase(TEN_YEARS + 100);
      // sole staker earns ~30M (dust from per-second truncation is negligible)
      expect(await farm.earned(alice.address)).to.be.closeTo(budget, ethers.parseEther("5"));
    });

    it("pays out BURN on getReward() (untaxed — farm is burn-exempt)", async function () {
      const { farm, burnTok, owner, alice, aliceIds } = await deployFixture();
      await farm.connect(alice).stake([aliceIds[0]]);
      await startDrip(farm, burnTok, owner, ethers.parseEther("70000"), WEEK);
      await time.increase(WEEK + 10);

      const before = await burnTok.balanceOf(alice.address);
      await farm.connect(alice).getReward();
      const got = (await burnTok.balanceOf(alice.address)) - before;
      expect(got).to.be.closeTo(ethers.parseEther("70000"), ethers.parseEther("1"));
    });

    it("does not accrue before a drip is started", async function () {
      const { farm, alice, aliceIds } = await deployFixture();
      await farm.connect(alice).stake([aliceIds[0]]);
      await time.increase(DAY);
      expect(await farm.earned(alice.address)).to.equal(0);
    });
  });

  describe("Withdraw / exit return the exact same NFTs", function () {
    it("returns the identical tokenIds to the owner", async function () {
      const { farm, nft, alice, aliceIds } = await deployFixture();
      const rare = aliceIds[3];
      await farm.connect(alice).stake([rare, aliceIds[4]]);

      await farm.connect(alice).withdraw([rare]);
      expect(await nft.ownerOf(rare)).to.equal(alice.address);
      expect(await farm.stakerOf(rare)).to.equal(ethers.ZeroAddress);
      expect(await farm.stakedBalanceOf(alice.address)).to.equal(1);
    });

    it("cannot withdraw an NFT you didn't stake", async function () {
      const { farm, alice, bob, aliceIds, bobIds } = await deployFixture();
      await farm.connect(alice).stake([aliceIds[0]]);
      await farm.connect(bob).stake([bobIds[0]]);
      await expect(farm.connect(bob).withdraw([aliceIds[0]])).to.be.revertedWith("Not your stake");
    });

    it("exit() returns all NFTs and claims rewards", async function () {
      const { farm, nft, burnTok, owner, alice, aliceIds } = await deployFixture();
      const ids = [aliceIds[0], aliceIds[1], aliceIds[2]];
      await farm.connect(alice).stake(ids);
      await startDrip(farm, burnTok, owner, ethers.parseEther("70000"), WEEK);
      await time.increase(WEEK + 10);

      await farm.connect(alice).exit();
      expect(await farm.stakedBalanceOf(alice.address)).to.equal(0);
      for (const id of ids) {
        expect(await nft.ownerOf(id)).to.equal(alice.address);
      }
      // sole staker => whole budget
      expect(await burnTok.balanceOf(alice.address)).to.be.closeTo(
        ethers.parseEther("70000"),
        ethers.parseEther("1")
      );
    });
  });

  describe("Works whether or not the farm is transfer-exempt", function () {
    it("preserves ids even when the farm is NOT exempt on the collection", async function () {
      const { farm, farmAddr, nft, alice, aliceIds } = await deployFixture();
      await nft.setWhitelist(farmAddr, false);
      const id = aliceIds[0];
      await farm.connect(alice).stake([id]);
      expect(await nft.ownerOf(id)).to.equal(farmAddr);
      await farm.connect(alice).withdraw([id]);
      expect(await nft.ownerOf(id)).to.equal(alice.address);
    });
  });

  describe("Owner controls & rescue", function () {
    it("reverts notifyRewardAmount if the farm is underfunded", async function () {
      const { farm, owner } = await deployFixture();
      await farm.connect(owner).setRewardsDuration(WEEK);
      await expect(
        farm.connect(owner).notifyRewardAmount(ethers.parseEther("70000"))
      ).to.be.revertedWith("Provided reward too high");
    });

    it("only owner can notify or set duration", async function () {
      const { farm, alice } = await deployFixture();
      await expect(
        farm.connect(alice).notifyRewardAmount(1)
      ).to.be.revertedWithCustomError(farm, "OwnableUnauthorizedAccount");
      await expect(
        farm.connect(alice).setRewardsDuration(WEEK)
      ).to.be.revertedWithCustomError(farm, "OwnableUnauthorizedAccount");
    });

    it("cannot change duration mid-window, can between windows", async function () {
      const { farm, burnTok, owner, alice, aliceIds } = await deployFixture();
      await farm.connect(alice).stake([aliceIds[0]]);
      await startDrip(farm, burnTok, owner, ethers.parseEther("70000"), WEEK);
      await expect(farm.connect(owner).setRewardsDuration(DAY)).to.be.revertedWith(
        "Period not finished"
      );
      await time.increase(WEEK + 10);
      await expect(farm.connect(owner).setRewardsDuration(3 * DAY)).to.not.be.reverted;
    });

    it("recoverERC721 cannot pull a staked NFT but can rescue a stray", async function () {
      const { farm, farmAddr, nft, owner, alice, bob, aliceIds, bobIds } = await deployFixture();
      await farm.connect(alice).stake([aliceIds[0]]);
      await expect(
        farm.connect(owner).recoverERC721(await nft.getAddress(), aliceIds[0], owner.address)
      ).to.be.revertedWith("Token is staked");

      await nft.connect(bob).transferFrom(bob.address, farmAddr, bobIds[0]);
      await farm.connect(owner).recoverERC721(await nft.getAddress(), bobIds[0], bob.address);
      expect(await nft.ownerOf(bobIds[0])).to.equal(bob.address);
    });

    it("recoverERC20 cannot touch the staking token", async function () {
      const { farm, nft, owner } = await deployFixture();
      await expect(
        farm.connect(owner).recoverERC20(await nft.getAddress(), ethers.parseEther("1"))
      ).to.be.revertedWith("Cannot recover staking token");
    });
  });
});
