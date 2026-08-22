/**
 * Pre-deploy checks. Read-only — it never sends a transaction.
 *
 *   npx hardhat run scripts/precheck.js --network pulsechain
 *
 * Confirms, before you spend anything:
 *   - the deployer key in .env resolves to the wallet you expect
 *   - it holds enough native PLS to cover deploy + wiring gas
 *   - the reward token is a sane ERC-20 and the wallet's balance covers the budget
 *   - the NFT collection is a real ERC-721, and what it does/doesn't expose
 *   - whether Multicall3 is available for owner-sweep discovery
 */
const hre = require("hardhat");
const { ethers } = hre;
const { TARGETS, MULTICALL3 } = require("./targets");

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];
const NFT_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function supportsInterface(bytes4) view returns (bool)",
  "function isApprovedForAll(address,address) view returns (bool)",
];

function line(ok, label, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  return ok;
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const t = TARGETS[chainId];

  console.log(`\nPRECHECK — network ${hre.network.name} (chainId ${chainId})`);
  console.log("=".repeat(64));

  let allOk = true;
  const ok = (...a) => { allOk = line(...a) && allOk; };

  // --- signer -------------------------------------------------------------
  const signers = await ethers.getSigners();
  if (!signers.length) {
    console.log("  FAIL  no signer — is the deployer key in .env?");
    process.exitCode = 1;
    return;
  }
  const me = signers[0];
  console.log(`\nDeployer`);
  ok(true, "key loaded from .env", me.address);
  if (t?.expectDeployer) {
    ok(
      me.address.toLowerCase() === t.expectDeployer.toLowerCase(),
      "matches the expected wallet",
      t.expectDeployer
    );
  }

  const bal = await ethers.provider.getBalance(me.address);
  const gasPrice = (await ethers.provider.getFeeData()).gasPrice ?? 0n;
  // Deploy ~3.0M gas, plus ~1.2M for wiring/approve/fund/notify.
  const estGas = 4_200_000n;
  const estCost = estGas * gasPrice;
  console.log(`\nGas`);
  console.log(`        balance   ${ethers.formatEther(bal)} PLS`);
  console.log(`        gasPrice  ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
  console.log(`        est. cost ${ethers.formatEther(estCost)} PLS  (~${estGas} gas)`);
  ok(bal > estCost * 3n, "balance covers deploy + wiring with 3x headroom");

  if (!t) {
    console.log(`\n  (no configured targets for chainId ${chainId} — skipping token checks)`);
    console.log(`\n${allOk ? "PRECHECK OK" : "PRECHECK FAILED"}\n`);
    if (!allOk) process.exitCode = 1;
    return;
  }

  // --- reward token -------------------------------------------------------
  console.log(`\nReward token  ${t.rewardToken}`);
  const rt = new ethers.Contract(t.rewardToken, ERC20_ABI, ethers.provider);
  try {
    const [nm, sym, dec, sup, myBal] = await Promise.all([
      rt.name(), rt.symbol(), rt.decimals(), rt.totalSupply(), rt.balanceOf(me.address),
    ]);
    console.log(`        ${nm} (${sym})  decimals ${dec}`);
    console.log(`        totalSupply ${ethers.formatUnits(sup, dec)}`);
    console.log(`        your balance ${ethers.formatUnits(myBal, dec)}`);
    ok(Number(dec) === 18, "decimals are 18", `got ${dec}`);
    const budget = ethers.parseUnits(String(t.budget), 18);
    ok(myBal >= budget, `balance covers the ${Number(t.budget).toLocaleString()} budget`);
  } catch (e) {
    ok(false, "reward token is a readable ERC-20", e.shortMessage || e.message);
  }

  // --- NFT collection -----------------------------------------------------
  console.log(`\nNFT collection  ${t.nft}`);
  const nft = new ethers.Contract(t.nft, NFT_ABI, ethers.provider);
  try {
    const [nm, sym, sup, myBal] = await Promise.all([
      nft.name(), nft.symbol(), nft.totalSupply(), nft.balanceOf(me.address),
    ]);
    console.log(`        ${nm} (${sym})  totalSupply ${sup}`);
    console.log(`        your balance ${myBal} NFT(s)`);
    const is721 = await nft.supportsInterface("0x80ac58cd");
    const isEnum = await nft.supportsInterface("0x780e9d63").catch(() => false);
    ok(is721, "implements ERC-721");
    console.log(`        ERC721Enumerable: ${isEnum ? "yes" : "NO — owner sweep required"}`);
    if (myBal === 0n) {
      console.log(`        NOTE: this wallet owns 0 — it can deploy and fund,`);
      console.log(`              but cannot exercise stake/withdraw itself.`);
    }
  } catch (e) {
    ok(false, "NFT collection is a readable ERC-721", e.shortMessage || e.message);
  }

  // --- multicall ----------------------------------------------------------
  const mcCode = await ethers.provider.getCode(MULTICALL3);
  console.log(`\nMulticall3  ${MULTICALL3}`);
  ok(mcCode !== "0x", "deployed (owner-sweep discovery available)");

  console.log(`\n${allOk ? "PRECHECK OK" : "PRECHECK FAILED"}\n`);
  if (!allOk) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
