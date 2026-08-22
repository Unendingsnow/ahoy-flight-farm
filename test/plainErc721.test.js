const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const E = ethers.parseEther;

/**
 * The farm against a PLAIN, NON-ENUMERABLE ERC-721.
 *
 * This is the shape the live collection actually has: only the ERC-721 core, no
 * `owned()` / `ownedIds()` / `tokensOfOwner()`, no ERC721Enumerable, and no
 * ERC-20 side. The other suites exercise the ERC-404 mock; this one pins down
 * that the deployed configuration works too, and that the assumptions the site's
 * discovery relies on actually hold.
 */
describe("NftStakeFarm against a plain ERC-721 (the live shape)", function () {
  const SUPPLY = 40;

  async function fixture() {
    const [owner, alice, bob] = await ethers.getSigners();

    // Ids 1..SUPPLY minted to alice; id 0 is never minted.
    const Plain = await ethers.getContractFactory("MockPlainERC721");
    const nft = await Plain.deploy(SUPPLY, alice.address);
    const nftAddr = await nft.getAddress();

    const Reward = await ethers.getContractFactory("MockRewardToken");
    const reward = await Reward.deploy(
      "Test Reward", "TRWD", owner.address, E("10000000"), owner.address, owner.address
    );
    const rewardAddr = await reward.getAddress();

    const Farm = await ethers.getContractFactory("NftStakeFarm");
    const farm = await Farm.deploy(owner.address, rewardAddr, nftAddr);
    const farmAddr = await farm.getAddress();

    await reward.setTaxExempt(farmAddr, true);
    await nft.connect(alice).setApprovalForAll(farmAddr, true);

    return { owner, alice, bob, nft, nftAddr, reward, rewardAddr, farm, farmAddr };
  }

  async function startDrip(farm, reward, owner, amount, duration) {
    await farm.connect(owner).setRewardsDuration(duration);
    await reward.connect(owner).approve(await farm.getAddress(), amount);
    await farm.connect(owner).fund(amount);
    await farm.connect(owner).notifyRewardAmount(await farm.unallocatedRewards());
  }

  describe("the collection really is the shape we assume", function () {
    it("implements ERC-721 but NOT ERC721Enumerable", async function () {
      const { nft } = await fixture();
      expect(await nft.supportsInterface("0x01ffc9a7")).to.equal(true); // ERC165
      expect(await nft.supportsInterface("0x80ac58cd")).to.equal(true); // ERC721
      expect(await nft.supportsInterface("0x5b5e139f")).to.equal(true); // Metadata
      expect(await nft.supportsInterface("0x780e9d63")).to.equal(false); // Enumerable
    });

    it("exposes no owner-enumeration method at all", async function () {
      const { nft } = await fixture();
      for (const fn of ["owned", "ownedIds", "tokensOfOwner", "walletOfOwner", "tokenOfOwnerByIndex"]) {
        expect(nft.interface.fragments.find((f) => f.name === fn), fn).to.equal(undefined);
      }
    });

    it("has no ERC-20 side", async function () {
      const { nft } = await fixture();
      for (const fn of ["decimals", "erc20BalanceOf", "transfer", "allowance"]) {
        expect(nft.interface.fragments.find((f) => f.name === fn), fn).to.equal(undefined);
      }
    });

    it("reverts ownerOf(0) — ids start at 1", async function () {
      const { nft } = await fixture();
      await expect(nft.ownerOf(0)).to.be.revertedWith("ERC721: invalid token ID");
      expect(await nft.ownerOf(1)).to.not.equal(ethers.ZeroAddress);
    });
  });

  describe("staking", function () {
    it("stakes, holds the exact ids, and returns them on withdraw", async function () {
      const { nft, farm, farmAddr, alice } = await fixture();
      const ids = [3, 7, 11];

      await farm.connect(alice).stake(ids);
      for (const id of ids) {
        expect(await nft.ownerOf(id)).to.equal(farmAddr);
        expect(await farm.stakerOf(id)).to.equal(alice.address);
      }
      expect(await farm.totalStaked()).to.equal(3);
      expect(await farm.stakerCount()).to.equal(1);
      expect(await nft.balanceOf(alice.address)).to.equal(SUPPLY - 3);

      await farm.connect(alice).withdraw(ids);
      for (const id of ids) {
        expect(await nft.ownerOf(id)).to.equal(alice.address);
        expect(await farm.stakerOf(id)).to.equal(ethers.ZeroAddress);
      }
      expect(await farm.totalStaked()).to.equal(0);
      expect(await nft.balanceOf(alice.address)).to.equal(SUPPLY);
    });

    it("splits the drip pro-rata and pays out on claim", async function () {
      const { nft, farm, farmAddr, reward, owner, alice, bob } = await fixture();

      // Give bob two ids so both wallets stake.
      await nft.connect(alice).transferFrom(alice.address, bob.address, 20);
      await nft.connect(alice).transferFrom(alice.address, bob.address, 21);
      await nft.connect(bob).setApprovalForAll(farmAddr, true);

      await startDrip(farm, reward, owner, E("700000"), 7 * DAY);
      const rate = await farm.rewardRate();

      await farm.connect(alice).stake([1, 2, 3]); // 3 shares
      await farm.connect(bob).stake([20, 21]); //    2 shares
      expect(await farm.totalStaked()).to.equal(5);

      await time.increase(DAY);
      const dayTotal = rate * BigInt(DAY);
      expect(await farm.earned(alice.address)).to.be.closeTo((dayTotal * 3n) / 5n, rate * 10n);
      expect(await farm.earned(bob.address)).to.be.closeTo((dayTotal * 2n) / 5n, rate * 10n);

      const owed = await farm.earned(alice.address);
      const before = await reward.balanceOf(alice.address);
      await farm.connect(alice).getReward();
      const got = (await reward.balanceOf(alice.address)) - before;
      expect(got).to.be.closeTo(owed, rate * 5n);
    });

    it("exit() returns every id and claims in one call", async function () {
      const { nft, farm, reward, owner, alice } = await fixture();
      await startDrip(farm, reward, owner, E("700000"), 7 * DAY);

      const ids = [5, 6, 8, 9];
      await farm.connect(alice).stake(ids);
      await time.increase(2 * DAY);

      const before = await reward.balanceOf(alice.address);
      await farm.connect(alice).exit();

      for (const id of ids) expect(await nft.ownerOf(id)).to.equal(alice.address);
      expect(await farm.totalStaked()).to.equal(0);
      expect(await farm.stakerCount()).to.equal(0);
      expect(await reward.balanceOf(alice.address)).to.be.gt(before);
      expect(await farm.earned(alice.address)).to.equal(0);
    });

    it("rejects an id the staker does not own", async function () {
      const { farm, farmAddr, nft, alice, bob } = await fixture();
      await nft.connect(bob).setApprovalForAll(farmAddr, true);
      await expect(farm.connect(bob).stake([1])).to.be.revertedWith("ERC721: wrong from");
    });

    it("rejects a direct safeTransferFrom — deposits must go through stake()", async function () {
      const { nft, farmAddr, alice } = await fixture();
      await expect(
        nft.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, farmAddr, 4)
      ).to.be.revertedWith("Use stake() to deposit");
    });
  });

  describe("rescue guards", function () {
    it("recoverERC721 cannot pull a staked id but can rescue a stray", async function () {
      const { nft, nftAddr, farm, farmAddr, owner, alice } = await fixture();
      await farm.connect(alice).stake([12]);

      await expect(
        farm.connect(owner).recoverERC721(nftAddr, 12, owner.address)
      ).to.be.revertedWith("Token is staked");

      // A stray sent in by plain transferFrom is not tracked, so it can be rescued.
      await nft.connect(alice).transferFrom(alice.address, farmAddr, 13);
      await farm.connect(owner).recoverERC721(nftAddr, 13, alice.address);
      expect(await nft.ownerOf(13)).to.equal(alice.address);
    });

    it("recoverERC20 cannot touch the staking token", async function () {
      const { farm, nftAddr, owner } = await fixture();
      await expect(
        farm.connect(owner).recoverERC20(nftAddr, 1)
      ).to.be.revertedWith("Cannot recover staking token");
    });
  });
});
