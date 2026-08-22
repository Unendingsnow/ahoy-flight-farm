/**
 * Deploys the farm exactly the way it will be deployed on the live chain:
 * UNCONFIGURED. Both the NFT collection and the reward token are wired in
 * afterwards from the admin panel, so the local run is a true rehearsal.
 *
 *   npm run deploy:local        -> mocks + bare farm, wire it yourself in admin.html
 *   npm run deploy:local:full   -> same, then auto-wires + funds + starts the drip
 *
 * On a live network no mocks are deployed; the farm comes up bare and every
 * address is set from the admin panel.
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;
const { writeAbi } = require("./export-abi");

const ROOT = path.join(__dirname, "..");

// --- Local test parameters -------------------------------------------------
const MOCK_COLLECTION_SIZE = 2832; // matches the real the collection collection
const MOCK_REWARD_SUPPLY = ethers.parseEther("100000000");
const APES_PER_TEST_WALLET = 6;

// --- Drip defaults (also what the admin panel pre-fills) -------------------
const DRIP_DAYS = 3650; // 10 years
const DRIP_SECONDS = DRIP_DAYS * 24 * 60 * 60;
const AUTO_WIRE_BUDGET = ethers.parseEther("30000000");

const LOCAL_NETWORKS = ["hardhat", "localhost", "localPulse"];

const NETWORK_META = {
  943: { name: "Local / PulseChain Testnet v4", rpc: "http://127.0.0.1:8545", explorer: "" },
  369: { name: "PulseChain", rpc: "https://rpc.pulsechain.com", explorer: "https://scan.pulsechain.com" },
  31337: { name: "Hardhat", rpc: "http://127.0.0.1:8545", explorer: "" },
};

function fmt(x) {
  return Number(ethers.formatEther(x)).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/** Merges this deployment into web/config.js, preserving other networks. */
function writeWebConfig(chainId, entry) {
  const file = path.join(ROOT, "web", "config.js");
  let existing = { defaultChainId: chainId, networks: {} };

  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, "utf8");
    const match = raw.match(/window\.FARM_CONFIG\s*=\s*([\s\S]*?);\s*$/);
    if (match) {
      try {
        existing = JSON.parse(match[1]);
      } catch {
        /* regenerate from scratch */
      }
    }
  }

  existing.defaultChainId = chainId;
  existing.networks = existing.networks || {};
  existing.networks[chainId] = { ...(existing.networks[chainId] || {}), ...entry };

  // Keep a live-chain placeholder around so switching networks is one edit.
  for (const [id, meta] of Object.entries(NETWORK_META)) {
    if (!existing.networks[id]) {
      existing.networks[id] = { ...meta, farm: "" };
    }
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    "// Written by scripts/deploy.js. Safe to edit — the site also accepts a\n" +
      "// farm address typed into its network panel (stored per-browser).\n" +
      `window.FARM_CONFIG = ${JSON.stringify(existing, null, 2)};\n`
  );
  return file;
}

function writeDeploymentRecord(record) {
  const dir = path.join(ROOT, "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${hre.network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  return file;
}

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const isLocal = LOCAL_NETWORKS.includes(hre.network.name);
  const autoWire = process.env.AUTO_WIRE === "1";

  console.log(`Network:   ${hre.network.name} (chainId ${chainId})`);
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Balance:   ${fmt(await ethers.provider.getBalance(deployer.address))}\n`);

  // ---------------------------------------------------------------- mocks --
  let nftAddress = process.env.NFT_ADDRESS || "";
  let rewardAddress = process.env.REWARD_ADDRESS || "";
  let mockNft = null;
  let mockReward = null;

  if (isLocal) {
    const Mock = await ethers.getContractFactory("MockNftCollection");
    mockNft = await Mock.deploy(ethers.parseEther(String(MOCK_COLLECTION_SIZE)));
    await mockNft.waitForDeployment();
    nftAddress = await mockNft.getAddress();
    console.log(`MockNftCollection:      ${nftAddress}   (${MOCK_COLLECTION_SIZE} NFTs)`);

    const Reward = await ethers.getContractFactory("MockRewardToken");
    mockReward = await Reward.deploy(
      "Mock Test Reward",
      "TRWD",
      deployer.address,
      MOCK_REWARD_SUPPLY,
      (signers[8] || deployer).address, // omega wallet
      (signers[9] || deployer).address // treasury / buy-back wallet
    );
    await mockReward.waitForDeployment();
    rewardAddress = await mockReward.getAddress();
    console.log(`MockRewardToken:  ${rewardAddress}   (1% burn / 1% omega / 1% treasury on buys+sells)`);
  } else {
    console.log("Live network — no mocks. Set the NFT + reward token from admin.html.");
    if (nftAddress) console.log(`  NFT_ADDRESS given:    ${nftAddress}`);
    if (rewardAddress) console.log(`  REWARD_ADDRESS given: ${rewardAddress}`);
  }

  // ----------------------------------------------------------------- farm --
  // Deployed bare on purpose: this is the live path, rehearsed locally.
  const Farm = await ethers.getContractFactory("NftStakeFarm");
  const farm = await Farm.deploy(deployer.address, ethers.ZeroAddress, ethers.ZeroAddress);
  await farm.waitForDeployment();
  const farmAddress = await farm.getAddress();
  console.log(`NftStakeFarm:      ${farmAddress}   (unconfigured)\n`);

  // ------------------------------------------------------- seed test NFTs --
  if (isLocal && mockNft) {
    const testWallets = signers.slice(1, 5);
    for (const w of testWallets) {
      await (await mockNft.transfer(w.address, ethers.parseEther(String(APES_PER_TEST_WALLET)))).wait();
    }
    console.log(`Seeded ${APES_PER_TEST_WALLET} NFTs each to ${testWallets.length} test wallets:`);
    for (const w of testWallets) {
      const ids = await mockNft.ownedIds(w.address);
      console.log(`  ${w.address}  ids ${ids.map(String).join(", ")}`);
    }
    console.log("");
  }

  // ------------------------------------------------------------ auto-wire --
  let wired = false;
  if (autoWire) {
    if (!nftAddress || !rewardAddress) {
      console.log("AUTO_WIRE=1 but NFT_ADDRESS / REWARD_ADDRESS are unknown — skipping.\n");
    } else {
      console.log("AUTO_WIRE=1 — running the exact calls admin.html would make:");
      await (await farm.setStakingToken(nftAddress)).wait();
      console.log("  setStakingToken");
      await (await farm.setRewardsToken(rewardAddress)).wait();
      console.log("  setRewardsToken");

      if (mockReward) {
        await (await mockReward.setTaxExempt(farmAddress, true)).wait();
        console.log("  reward token: farm marked tax-exempt");
      }
      if (mockNft) {
        await (await mockNft.setWhitelist(farmAddress, true)).wait();
        console.log("  the collection: farm marked ERC-721 transfer-exempt");
      }

      await (await farm.setRewardsDuration(DRIP_SECONDS)).wait();
      console.log(`  setRewardsDuration(${DRIP_SECONDS})  = ${DRIP_DAYS} days`);

      const rewardToken = mockReward ?? (await ethers.getContractAt("MockRewardToken", rewardAddress));
      await (await rewardToken.approve(farmAddress, AUTO_WIRE_BUDGET)).wait();
      await (await farm.fundAndStart(AUTO_WIRE_BUDGET)).wait();
      console.log(`  fundAndStart(${fmt(AUTO_WIRE_BUDGET)})\n`);
      wired = true;
    }
  }

  // ------------------------------------------------------------- printout --
  const info = await farm.farmInfo();
  const rate = info.rewardRate_;
  if (rate > 0n) {
    const perDay = rate * 86400n;
    const size = BigInt(MOCK_COLLECTION_SIZE);
    console.log("--- Emission math ---");
    console.log(`Total / second:  ${fmt(rate)}`);
    console.log(`Total / day:     ${fmt(perDay)}`);
    console.log(`Total / year:    ${fmt(perDay * 365n)}`);
    console.log(`At full collection (${size} NFTs):`);
    console.log(`  per NFT / day:   ${fmt(perDay / size)}`);
    console.log(`  per NFT / year:  ${fmt((perDay * 365n) / size)}`);
    console.log("(Fewer NFTs staked => each staked NFT earns a bigger share; the total stays capped.)\n");
  }

  const record = {
    network: hre.network.name,
    chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    farm: farmAddress,
    stakingToken: info.stakingToken_,
    rewardsToken: info.rewardsToken_,
    configured: info.stakingToken_ !== ethers.ZeroAddress && info.rewardsToken_ !== ethers.ZeroAddress,
    mocks: isLocal ? { nft: nftAddress, reward: rewardAddress } : null,
    rewardRatePerSecond: ethers.formatEther(rate),
    rewardsDuration: Number(info.rewardsDuration_),
  };

  const meta = NETWORK_META[chainId] || { name: hre.network.name, rpc: "", explorer: "" };
  const configFile = writeWebConfig(chainId, {
    ...meta,
    farm: farmAddress,
    // Mock addresses are informational only — the site reads the real ones
    // straight off the farm via farmInfo().
    mockNft: isLocal ? nftAddress : undefined,
    mockReward: isLocal ? rewardAddress : undefined,
  });
  const recordFile = writeDeploymentRecord(record);
  const abi = writeAbi();

  console.log("--- Deployment summary ---");
  console.log(JSON.stringify(record, null, 2));
  console.log(`\nWrote ${path.relative(ROOT, configFile)}`);
  console.log(`Wrote ${path.relative(ROOT, recordFile)}`);
  console.log(`Wrote ${path.relative(ROOT, abi.file)}`);

  if (!wired) {
    console.log("\nNEXT: run `npm run web`, open http://127.0.0.1:8080/admin.html and:");
    console.log("  1. Set NFT collection      ->", nftAddress || "<the collection address>");
    console.log("  2. Set reward token        ->", rewardAddress || "<reward token address>");
    console.log("  3. Set drip duration, then Fund & Start.");
  } else {
    console.log("\nNEXT: run `npm run web` and open http://127.0.0.1:8080/");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
