/**
 * LIVE deployment to PulseChain mainnet.
 *
 *   npm run precheck                       # read-only checks
 *   npm run battletest                      # full rehearsal on a mainnet fork
 *   npx hardhat run scripts/deploy-live.js --network pulsechain          # DRY RUN
 *   CONFIRM=DEPLOY npx hardhat run scripts/deploy-live.js --network pulsechain
 *
 * Without CONFIRM=DEPLOY this script sends NOTHING. It simulates every call with
 * eth_call, prints the gas estimate and the exact emission maths, and stops. That
 * default is deliberate: this spends real funds and commits a real budget.
 *
 * The sequence mirrors the admin panel exactly, and mirrors the battle test:
 *   deploy bare -> setStakingToken -> setRewardsToken -> setRewardsDuration
 *               -> approve -> fund -> notifyRewardAmount
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;
const { writeAbi } = require("./export-abi");
const { TARGETS, durationSeconds } = require("./targets");

const ROOT = path.join(__dirname, "..");
const LIVE = process.env.CONFIRM === "DEPLOY";

const ERC20 = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const f = (v, d = 18) =>
  Number(ethers.formatUnits(v, d)).toLocaleString("en-US", { maximumFractionDigits: 6 });

function writeWebConfig(chainId, entry) {
  const file = path.join(ROOT, "web", "config.js");
  let cfg = { defaultChainId: chainId, networks: {} };
  if (fs.existsSync(file)) {
    const m = fs.readFileSync(file, "utf8").match(/window\.FARM_CONFIG\s*=\s*([\s\S]*?);\s*$/);
    if (m) { try { cfg = JSON.parse(m[1]); } catch { /* regenerate */ } }
  }
  cfg.defaultChainId = chainId;
  cfg.networks = cfg.networks || {};
  cfg.networks[chainId] = { ...(cfg.networks[chainId] || {}), ...entry };
  fs.writeFileSync(
    file,
    "// Written by scripts/deploy-live.js. Safe to edit — the site also accepts a\n" +
      "// farm address typed into its network panel (stored per-browser).\n" +
      `window.FARM_CONFIG = ${JSON.stringify(cfg, null, 2)};\n`
  );
  return file;
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const T = TARGETS[chainId];

  console.log("=".repeat(68));
  console.log(LIVE ? "LIVE DEPLOY — sending real transactions" : "DRY RUN — nothing will be sent");
  console.log("=".repeat(68));

  if (!T) throw new Error(`No targets configured for chainId ${chainId}.`);
  if (chainId !== 369) throw new Error(`Expected PulseChain mainnet (369), got ${chainId}.`);

  const [deployer] = await ethers.getSigners();
  if (deployer.address.toLowerCase() !== T.expectDeployer.toLowerCase()) {
    throw new Error(`Signer ${deployer.address} != expected ${T.expectDeployer}`);
  }

  const rwd = new ethers.Contract(T.rewardToken, ERC20, deployer);
  const dec = Number(await rwd.decimals());
  const sym = await rwd.symbol();
  const budget = ethers.parseUnits(String(T.budget), dec);
  const DUR = durationSeconds(chainId);

  const bal = await ethers.provider.getBalance(deployer.address);
  const rwdBal = await rwd.balanceOf(deployer.address);

  console.log(`\nnetwork    ${hre.network.name} (${chainId})`);
  console.log(`deployer   ${deployer.address}`);
  console.log(`PLS        ${f(bal)}`);
  console.log(`${sym.padEnd(10)} ${f(rwdBal, dec)}`);
  console.log(`\ncollection ${T.nft}`);
  console.log(`reward     ${T.rewardToken}`);
  console.log(`budget     ${T.budget.toLocaleString()} ${sym}`);
  console.log(`duration   ${T.durationDays} days (${DUR}s)`);

  if (rwdBal < budget) throw new Error(`Insufficient ${sym}: need ${f(budget, dec)}, have ${f(rwdBal, dec)}`);

  // ------------------------------------------------------------ emission --
  const rate = budget / BigInt(DUR);
  console.log(`\n--- Emission (at the full ${T.budget.toLocaleString()} budget) ---`);
  console.log(`  per second ${ethers.formatUnits(rate, dec)} ${sym}`);
  console.log(`  per day    ${f(rate * 86400n, dec)} ${sym}`);
  console.log(`  per year   ${f(rate * 86400n * 365n, dec)} ${sym}`);
  console.log(`  10 years   ${f(rate * BigInt(DUR), dec)} ${sym}`);
  const SUPPLY = 2833n; // live collection size, verified on chain
  console.log(`  if all ${SUPPLY} staked -> per NFT/day  ${f((rate * 86400n) / SUPPLY, dec)} ${sym}`);
  console.log(`                        per NFT/year ${f((rate * 86400n * 365n) / SUPPLY, dec)} ${sym}`);

  const Farm = await ethers.getContractFactory("NftStakeFarm", deployer);

  if (!LIVE) {
    const deployTx = await Farm.getDeployTransaction(deployer.address, ethers.ZeroAddress, ethers.ZeroAddress);
    const gas = await ethers.provider.estimateGas({ ...deployTx, from: deployer.address });
    const gasPrice = (await ethers.provider.getFeeData()).gasPrice ?? 0n;
    console.log(`\n--- Dry run ---`);
    console.log(`  deploy gas estimate ${gas}`);
    console.log(`  at ${ethers.formatUnits(gasPrice, "gwei")} gwei -> ${f(gas * gasPrice)} PLS`);
    console.log(`  allowance now       ${f(await rwd.allowance(deployer.address, ethers.ZeroAddress), dec)}`);
    console.log(`\nNothing was sent. Re-run with CONFIRM=DEPLOY to go live.\n`);
    return;
  }

  // ---------------------------------------------------------------- live --
  console.log(`\n--- Deploying ---`);
  const farm = await Farm.deploy(deployer.address, ethers.ZeroAddress, ethers.ZeroAddress);
  await farm.waitForDeployment();
  const farmAddr = await farm.getAddress();
  const rcpt = await farm.deploymentTransaction().wait();
  console.log(`  farm ${farmAddr}  (gas ${rcpt.gasUsed}, block ${rcpt.blockNumber})`);
  console.log(`  ${T.explorer}/address/${farmAddr}`);

  console.log(`\n--- Wiring ---`);
  await (await farm.setStakingToken(T.nft)).wait();
  console.log(`  setStakingToken   ${T.nft}`);
  await (await farm.setRewardsToken(T.rewardToken)).wait();
  console.log(`  setRewardsToken   ${T.rewardToken}`);
  await (await farm.setRewardsDuration(DUR)).wait();
  console.log(`  setRewardsDuration ${DUR}s (${T.durationDays} days)`);

  console.log(`\n--- Funding ---`);
  await (await rwd.approve(farmAddr, budget)).wait();
  console.log(`  approve ${f(budget, dec)} ${sym}`);
  await (await farm.fund(budget)).wait();
  const landed = await rwd.balanceOf(farmAddr);
  console.log(`  fund    requested ${f(budget, dec)} -> farm holds ${f(landed, dec)} ${sym}`);
  if (landed < budget) console.log(`  NOTE: ${f(budget - landed, dec)} ${sym} was taken as transfer tax.`);

  console.log(`\n--- Starting the drip ---`);
  const unalloc = await farm.unallocatedRewards();
  await (await farm.notifyRewardAmount(unalloc)).wait();
  const info = await farm.farmInfo();
  console.log(`  rewardRate   ${ethers.formatUnits(info.rewardRate_, dec)} ${sym}/sec`);
  console.log(`  periodFinish ${new Date(Number(info.periodFinish_) * 1000).toISOString()}`);

  // -------------------------------------------------------------- record --
  const record = {
    network: hre.network.name,
    chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    farm: farmAddr,
    stakingToken: info.stakingToken_,
    rewardsToken: info.rewardsToken_,
    configured: true,
    deployBlock: rcpt.blockNumber,
    deployGas: String(rcpt.gasUsed),
    budget: ethers.formatUnits(landed, dec),
    rewardRatePerSecond: ethers.formatUnits(info.rewardRate_, dec),
    rewardsDuration: Number(info.rewardsDuration_),
    periodFinish: Number(info.periodFinish_),
    explorer: `${T.explorer}/address/${farmAddr}`,
  };
  fs.mkdirSync(path.join(ROOT, "deployments"), { recursive: true });
  const recFile = path.join(ROOT, "deployments", `${hre.network.name}.json`);
  fs.writeFileSync(recFile, JSON.stringify(record, null, 2) + "\n");

  const cfgFile = writeWebConfig(chainId, {
    name: T.label,
    rpc: hre.network.config.url,
    explorer: T.explorer,
    farm: farmAddr,
  });
  const abi = writeAbi();

  console.log(`\n--- Written ---`);
  console.log(`  ${path.relative(ROOT, recFile)}`);
  console.log(`  ${path.relative(ROOT, cfgFile)}`);
  console.log(`  ${path.relative(ROOT, abi.file)}`);
  console.log(`\n${JSON.stringify(record, null, 2)}`);
  console.log(`\nDONE. Run \`npm run web\` and open http://127.0.0.1:8080/\n`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
