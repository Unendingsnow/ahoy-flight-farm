const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MockBurnToken (fixed supply + self-burn)", function () {
  async function deploy(initial = ethers.parseEther("35000000")) {
    const [treasury, alice, bob] = await ethers.getSigners();
    const BurnTok = await ethers.getContractFactory("MockBurnToken");
    const burnTok = await BurnTok.deploy(treasury.address, initial);
    await burnTok.waitForDeployment();
    return { burnTok, treasury, alice, bob };
  }

  describe("Supply", function () {
    it("mints the full supply to the treasury and has no mint function", async function () {
      const { burnTok, treasury } = await deploy();
      expect(await burnTok.totalSupply()).to.equal(ethers.parseEther("35000000"));
      expect(await burnTok.balanceOf(treasury.address)).to.equal(ethers.parseEther("35000000"));
      expect(await burnTok.MAX_SUPPLY()).to.equal(ethers.parseEther("35000000"));
      // fixed supply: the contract exposes no way to mint more
      expect(burnTok.interface.fragments.find((f) => f.name === "mint")).to.equal(undefined);
    });

    it("cannot deploy above MAX_SUPPLY", async function () {
      const BurnTok = await ethers.getContractFactory("MockBurnToken");
      const [treasury] = await ethers.getSigners();
      await expect(
        BurnTok.deploy(treasury.address, ethers.parseEther("35000001"))
      ).to.be.revertedWith("exceeds max supply");
    });
  });

  describe("Self-burn on transfer", function () {
    it("burns burnBps of an ordinary (non-exempt) transfer", async function () {
      const { burnTok, treasury, alice, bob } = await deploy();
      // seed alice (treasury is exempt -> she receives the full amount)
      await burnTok.transfer(alice.address, ethers.parseEther("1000"));
      expect(await burnTok.balanceOf(alice.address)).to.equal(ethers.parseEther("1000"));

      const supplyBefore = await burnTok.totalSupply();
      // alice -> bob, both non-exempt: default 100 bps (1%) burned
      await burnTok.connect(alice).transfer(bob.address, ethers.parseEther("100"));

      expect(await burnTok.balanceOf(bob.address)).to.equal(ethers.parseEther("99")); // 1% burned
      expect(await burnTok.balanceOf(alice.address)).to.equal(ethers.parseEther("900"));
      expect(supplyBefore - (await burnTok.totalSupply())).to.equal(ethers.parseEther("1")); // supply shrank
    });

    it("treasury and exempt addresses pay/trigger no burn", async function () {
      const { burnTok, treasury, alice, bob } = await deploy();
      // treasury -> alice: no burn (treasury exempt)
      await burnTok.transfer(alice.address, ethers.parseEther("100"));
      expect(await burnTok.balanceOf(alice.address)).to.equal(ethers.parseEther("100"));

      // exempt bob as a receiver -> alice -> bob is untaxed
      await burnTok.setBurnExempt(bob.address, true);
      await burnTok.connect(alice).transfer(bob.address, ethers.parseEther("50"));
      expect(await burnTok.balanceOf(bob.address)).to.equal(ethers.parseEther("50"));
    });

    it("owner can change the burn rate within the cap", async function () {
      const { burnTok, alice, bob } = await deploy();
      await burnTok.transfer(alice.address, ethers.parseEther("1000"));

      await burnTok.setBurnBps(500); // 5%
      await burnTok.connect(alice).transfer(bob.address, ethers.parseEther("100"));
      expect(await burnTok.balanceOf(bob.address)).to.equal(ethers.parseEther("95"));

      await expect(burnTok.setBurnBps(1001)).to.be.revertedWith("burn too high");
    });

    it("burnBps = 0 disables the burn entirely", async function () {
      const { burnTok, alice, bob } = await deploy();
      await burnTok.transfer(alice.address, ethers.parseEther("1000"));
      await burnTok.setBurnBps(0);
      await burnTok.connect(alice).transfer(bob.address, ethers.parseEther("100"));
      expect(await burnTok.balanceOf(bob.address)).to.equal(ethers.parseEther("100"));
    });

    it("only owner can set burn params", async function () {
      const { burnTok, alice, bob } = await deploy();
      await expect(burnTok.connect(alice).setBurnBps(0)).to.be.revertedWithCustomError(
        burnTok,
        "OwnableUnauthorizedAccount"
      );
      await expect(
        burnTok.connect(alice).setBurnExempt(bob.address, true)
      ).to.be.revertedWithCustomError(burnTok, "OwnableUnauthorizedAccount");
    });
  });
});
