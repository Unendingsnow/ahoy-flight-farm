const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const E = ethers.parseEther;
const ZERO = ethers.ZeroAddress;

/**
 * The emergency unstake exists so a bug in this farm can never trap someone's
 * NFT. That makes its most important property a NEGATIVE one: it must be
 * impossible to use as a way to take anything.
 *
 * Every test below is really one of two questions —
 *   can the owner get people out?      (it must work, under any conditions)
 *   can the owner get anything?        (it must not, under any conditions)
 */
describe("NftStakeFarm — emergency unstake (evict, never seize)", function () {
  async function fixture() {
    const [owner, alice, bob, carol] = await ethers.getSigners();

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
    await reward.setTaxExempt(farmAddr, true);

    const owned = new Map();
    for (const a of [alice, bob, carol]) {
      await nft.transfer(a.address, E("5"));
      await nft.connect(a).setApprovalForAll(farmAddr, true);
      owned.set(a.address, (await nft.ownedIds(a.address)).map((x) => x.toString()));
    }

    await farm.setRewardsDuration(100 * DAY);
    await reward.approve(farmAddr, E("10000000"));
    await farm.fund(E("1000000"));
    await farm.notifyRewardAmount(await farm.unallocatedRewards());

    return { owner, alice, bob, carol, nft, nftAddr, reward, farm, farmAddr, owned };
  }

  describe("Getting people out", function () {
    it("returns every NFT to the staker and clears the stake", async function () {
      const { owner, alice, nft, farm, farmAddr, owned } = await fixture();
      const ids = owned.get(alice.address).slice(0, 3);
      await farm.connect(alice).stake(ids);
      expect(await farm.totalStaked()).to.equal(3);

      await farm.connect(owner).setStakingPaused(true);
      await farm.connect(owner).emergencyUnstake(alice.address, 0);

      for (const id of ids) {
        expect(await nft.ownerOf(id), `NFT ${id} did not go home`).to.equal(alice.address);
        expect(await farm.stakerOf(id)).to.equal(ZERO);
      }
      expect(await farm.totalStaked()).to.equal(0);
      expect(await farm.stakerCount()).to.equal(0);
      expect((await farm.stakedTokens(alice.address)).length).to.equal(0);
    });

    it("keeps their earned rewards claimable afterwards", async function () {
      const { owner, alice, reward, farm, owned } = await fixture();
      await farm.connect(alice).stake(owned.get(alice.address).slice(0, 2));
      await time.increase(10 * DAY);

      const earnedBefore = await farm.earned(alice.address);
      expect(earnedBefore).to.be.gt(0);

      await farm.connect(owner).setStakingPaused(true);
      await farm.connect(owner).emergencyUnstake(alice.address, 0);

      // Checkpointed, not forfeited.
      expect(await farm.earned(alice.address)).to.be.closeTo(earnedBefore, E("1"));
      const before = await reward.balanceOf(alice.address);
      await farm.connect(alice).getReward();
      expect((await reward.balanceOf(alice.address)) - before).to.be.closeTo(earnedBefore, E("1"));
    });

    it("works when the reward token is completely broken", async function () {
      // The whole point of a failsafe: it cannot depend on the thing that broke.
      const [owner, alice] = await ethers.getSigners();
      const Mock = await ethers.getContractFactory("MockNftCollection");
      const nft = await Mock.deploy(E("10000"));
      const Farm = await ethers.getContractFactory("NftStakeFarm");
      // Reward token is a plain EOA-less address with no code at all.
      const farm = await Farm.deploy(owner.address, ZERO, await nft.getAddress());
      const farmAddr = await farm.getAddress();
      await nft.setWhitelist(farmAddr, true);
      await nft.transfer(alice.address, E("2"));
      await nft.connect(alice).setApprovalForAll(farmAddr, true);

      // Farm is not configured (no reward token), so staking is blocked — wire a
      // reward token, stake, then point the farm at a dead token.
      const Reward = await ethers.getContractFactory("MockRewardToken");
      const reward = await Reward.deploy("R", "R", owner.address, E("1000"), owner.address, owner.address);
      await farm.setRewardsToken(await reward.getAddress());
      const ids = (await nft.ownedIds(alice.address)).map(String);
      await farm.connect(alice).stake([ids[0]]);

      await farm.connect(owner).setStakingPaused(true);
      await expect(farm.connect(owner).emergencyUnstake(alice.address, 0)).to.not.be.reverted;
      expect(await nft.ownerOf(ids[0])).to.equal(alice.address);
    });

    it("pages through a large stake with maxCount", async function () {
      const { owner, alice, nft, farm, owned } = await fixture();
      const ids = owned.get(alice.address);
      await farm.connect(alice).stake(ids);
      await farm.connect(owner).setStakingPaused(true);

      await farm.connect(owner).emergencyUnstake(alice.address, 2);
      expect(await farm.totalStaked()).to.equal(BigInt(ids.length - 2));
      expect(await farm.stakerCount()).to.equal(1, "still a staker mid-way through");

      await farm.connect(owner).emergencyUnstake(alice.address, 0);
      expect(await farm.totalStaked()).to.equal(0);
      expect(await farm.stakerCount()).to.equal(0);
      for (const id of ids) expect(await nft.ownerOf(id)).to.equal(alice.address);
    });

    it("clears a whole farm across many stakers in one call", async function () {
      const { owner, alice, bob, carol, nft, farm, owned } = await fixture();
      await farm.connect(alice).stake(owned.get(alice.address).slice(0, 2));
      await farm.connect(bob).stake(owned.get(bob.address).slice(0, 3));
      await farm.connect(carol).stake(owned.get(carol.address).slice(0, 1));
      expect(await farm.totalStaked()).to.equal(6);

      await farm.connect(owner).setStakingPaused(true);
      await farm.connect(owner).emergencyUnstakeMany(
        [alice.address, bob.address, carol.address], 0
      );

      expect(await farm.totalStaked()).to.equal(0);
      expect(await farm.stakerCount()).to.equal(0);
      for (const who of [alice, bob, carol]) {
        for (const id of owned.get(who.address)) {
          expect(await nft.ownerOf(id)).to.equal(who.address);
        }
      }
    });

    it("skips addresses with nothing staked, so a stale list is fine", async function () {
      const { owner, alice, bob, farm, owned } = await fixture();
      await farm.connect(alice).stake(owned.get(alice.address).slice(0, 1));
      await farm.connect(owner).setStakingPaused(true);

      await expect(
        farm.connect(owner).emergencyUnstakeMany([bob.address, alice.address, bob.address], 0)
      ).to.not.be.reverted;
      expect(await farm.totalStaked()).to.equal(0);
    });

    it("leaves the drip accounting solvent", async function () {
      const { owner, alice, bob, reward, farm, farmAddr, owned } = await fixture();
      await farm.connect(alice).stake(owned.get(alice.address).slice(0, 2));
      await farm.connect(bob).stake(owned.get(bob.address).slice(0, 2));
      await time.increase(20 * DAY);

      await farm.connect(owner).setStakingPaused(true);
      await farm.connect(owner).emergencyUnstakeMany([alice.address, bob.address], 0);

      const balance = await reward.balanceOf(farmAddr);
      expect(balance).to.be.gte((await farm.outstandingRewards()) + (await farm.scheduledRewards()));
      await expect(farm.connect(alice).getReward()).to.not.be.reverted;
      await expect(farm.connect(bob).getReward()).to.not.be.reverted;
    });

    it("emits the ids it moved", async function () {
      const { owner, alice, farm, owned } = await fixture();
      const ids = owned.get(alice.address).slice(0, 2);
      await farm.connect(alice).stake(ids);
      await farm.connect(owner).setStakingPaused(true);
      await farm.connect(owner).emergencyUnstake(alice.address, 0);

      const [log] = await farm.queryFilter(farm.filters.EmergencyUnstaked());
      expect(log.args.user).to.equal(alice.address);
      expect(log.args.tokenIds.map(String).sort()).to.deep.equal([...ids].sort());
    });
  });

  describe("Getting anything — every one of these must fail", function () {
    it("has no parameter that could send an NFT anywhere but to its staker", async function () {
      const { farm } = await fixture();
      // A destination argument is the whole attack surface; there must not be one.
      const frag = farm.interface.getFunction("emergencyUnstake");
      expect(frag.inputs.map((i) => i.type)).to.deep.equal(["address", "uint256"]);
      expect(frag.inputs[0].name).to.equal("user");
      // ...and no overload smuggles one in.
      const names = farm.interface.fragments
        .filter((f) => f.type === "function" && f.name.startsWith("emergencyUnstake") && f.stateMutability !== "view")
        .map((f) => f.format());
      expect(names.sort()).to.deep.equal([
        "emergencyUnstake(address,uint256)",
        "emergencyUnstakeMany(address[],uint256)",
      ]);
    });

    it("sends NFTs to the staker even when the owner names someone else", async function () {
      const { owner, alice, nft, farm, owned } = await fixture();
      const ids = owned.get(alice.address).slice(0, 2);
      await farm.connect(alice).stake(ids);
      await farm.connect(owner).setStakingPaused(true);

      // The owner can only name WHOSE stake to release, never where it goes.
      await farm.connect(owner).emergencyUnstake(alice.address, 0);
      for (const id of ids) {
        expect(await nft.ownerOf(id)).to.equal(alice.address);
        expect(await nft.ownerOf(id)).to.not.equal(owner.address);
      }
    });

    it("cannot be called by a non-owner", async function () {
      const { owner, alice, bob, farm, owned } = await fixture();
      await farm.connect(alice).stake(owned.get(alice.address).slice(0, 1));
      await farm.connect(owner).setStakingPaused(true);

      await expect(farm.connect(bob).emergencyUnstake(alice.address, 0))
        .to.be.revertedWithCustomError(farm, "OwnableUnauthorizedAccount");
      await expect(farm.connect(bob).emergencyUnstakeMany([alice.address], 0))
        .to.be.revertedWithCustomError(farm, "OwnableUnauthorizedAccount");
      await expect(farm.connect(alice).disableEmergencyUnstake())
        .to.be.revertedWithCustomError(farm, "OwnableUnauthorizedAccount");
    });

    it("cannot be used quietly — staking must be paused first", async function () {
      const { owner, alice, farm, owned } = await fixture();
      await farm.connect(alice).stake(owned.get(alice.address).slice(0, 1));

      await expect(farm.connect(owner).emergencyUnstake(alice.address, 0))
        .to.be.revertedWith("Pause staking first");
      await expect(farm.connect(owner).emergencyUnstakeMany([alice.address], 0))
        .to.be.revertedWith("Pause staking first");
    });

    it("cannot touch reward tokens at all", async function () {
      const { owner, alice, reward, farm, farmAddr, owned } = await fixture();
      await farm.connect(alice).stake(owned.get(alice.address).slice(0, 2));
      await time.increase(10 * DAY);

      const ownerBefore = await reward.balanceOf(owner.address);
      const farmBefore = await reward.balanceOf(farmAddr);

      await farm.connect(owner).setStakingPaused(true);
      await farm.connect(owner).emergencyUnstake(alice.address, 0);

      expect(await reward.balanceOf(owner.address)).to.equal(ownerBefore, "owner gained reward");
      expect(await reward.balanceOf(farmAddr)).to.equal(farmBefore, "farm balance moved");
    });

    it("cannot reach an NFT nobody staked", async function () {
      const { owner, alice, farm } = await fixture();
      await farm.connect(owner).setStakingPaused(true);
      await expect(farm.connect(owner).emergencyUnstake(alice.address, 0))
        .to.be.revertedWith("Nothing staked");
    });

    it("does not let recoverERC721 pick up what it released", async function () {
      const { owner, alice, nft, nftAddr, farm, owned } = await fixture();
      const ids = owned.get(alice.address).slice(0, 1);
      await farm.connect(alice).stake(ids);
      await farm.connect(owner).setStakingPaused(true);
      await farm.connect(owner).emergencyUnstake(alice.address, 0);

      // It is alice's again — the farm no longer holds it to recover.
      expect(await nft.ownerOf(ids[0])).to.equal(alice.address);
      await expect(
        farm.connect(owner).recoverERC721(nftAddr, ids[0], owner.address)
      ).to.be.reverted;
    });
  });

  describe("Giving the power up", function () {
    it("disable is permanent and blocks both entry points", async function () {
      const { owner, alice, farm, owned } = await fixture();
      await farm.connect(alice).stake(owned.get(alice.address).slice(0, 1));
      await farm.connect(owner).setStakingPaused(true);

      expect(await farm.emergencyUnstakeDisabled()).to.equal(false);
      await expect(farm.connect(owner).disableEmergencyUnstake())
        .to.emit(farm, "EmergencyUnstakeDisabled");
      expect(await farm.emergencyUnstakeDisabled()).to.equal(true);

      await expect(farm.connect(owner).emergencyUnstake(alice.address, 0))
        .to.be.revertedWith("Emergency unstake disabled");
      await expect(farm.connect(owner).emergencyUnstakeMany([alice.address], 0))
        .to.be.revertedWith("Emergency unstake disabled");

      // There is no way back on.
      expect(
        farm.interface.fragments.find(
          (f) => f.type === "function" && /enableEmergency|setEmergency/i.test(f.name || "")
        )
      ).to.equal(undefined);
    });

    it("stakers can still leave normally once it is disabled", async function () {
      const { owner, alice, nft, farm, owned } = await fixture();
      const ids = owned.get(alice.address).slice(0, 2);
      await farm.connect(alice).stake(ids);
      await farm.connect(owner).disableEmergencyUnstake();

      await farm.connect(alice).exit();
      for (const id of ids) expect(await nft.ownerOf(id)).to.equal(alice.address);
    });
  });
});
