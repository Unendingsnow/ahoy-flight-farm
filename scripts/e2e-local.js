/**
 * End-to-end rehearsal against a running node (`npm run node`).
 *
 * Drives the EXACT call sequence the admin panel and the farm site make —
 * wire tokens, exempt, set duration, deposit, start, approve, stake, accrue,
 * claim, withdraw — and asserts the outcome at every step. If this passes, the
 * deployed bytecode plus the UI's flow are known-good together.
 *
 *   terminal 1:  npm run node
 *   terminal 2:  npm run deploy:local     (leaves the farm unconfigured)
 *   terminal 2:  npm run e2e:local
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const RECORD = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);

let checks = 0;
function ok(label, condition, detail = "") {
  checks += 1;
  if (!condition) throw new Error(`FAILED: ${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ok  ${label}${detail ? `  (${detail})` : ""}`);
}
function step(n, title) {
  console.log(`\n${n}. ${title}`);
}
const eth = (x) => Number(ethers.formatEther(x)).toLocaleString("en-US", { maximumFractionDigits: 4 });

async function advance(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

async function main() {
  if (!fs.existsSync(RECORD)) {
    throw new Error(`No deployment record at ${RECORD}. Run \`npm run deploy:local\` first.`);
  }
  const record = JSON.parse(fs.readFileSync(RECORD, "utf8"));
  const signers = await ethers.getSigners();
  const [owner, alice, bob] = signers;

  console.log(`Farm:   ${record.farm}`);
  console.log(`Owner:  ${owner.address}`);
  if (!record.mocks) throw new Error("This rehearsal expects the local mocks from deploy.js.");

  const farm = await ethers.getContractAt("NftStakeFarm", record.farm);
  const nft = await ethers.getContractAt("MockNftCollection", record.mocks.nft);
  const reward = await ethers.getContractAt("MockRewardToken", record.mocks.reward);

  // ------------------------------------------------------------------ wire --
  step(1, "Wire the farm (what admin.html does)");
  let info = await farm.farmInfo();

  if (info.stakingToken_ === ethers.ZeroAddress) {
    await (await farm.connect(owner).setStakingToken(record.mocks.nft)).wait();
  }
  if (info.rewardsToken_ === ethers.ZeroAddress) {
    await (await farm.connect(owner).setRewardsToken(record.mocks.reward)).wait();
  }
  info = await farm.farmInfo();
  ok("staking token set", info.stakingToken_ === record.mocks.nft, info.stakingToken_);
  ok("reward token set", info.rewardsToken_ === record.mocks.reward, info.rewardsToken_);
  ok("farm reports configured", await farm.isConfigured());

  if (!(await nft.whitelist(record.farm))) {
    await (await nft.connect(owner).setWhitelist(record.farm, true)).wait();
  }
  if (!(await reward.isTaxExempt(record.farm))) {
    await (await reward.connect(owner).setTaxExempt(record.farm, true)).wait();
  }
  ok("farm ERC-721 transfer-exempt on the collection", await nft.whitelist(record.farm));
  ok("farm tax-exempt on the reward token", await reward.isTaxExempt(record.farm));

  // ------------------------------------------------------------- fund/start --
  step(2, "Set a short window, deposit and start the drip");
  const WINDOW = 7 * 24 * 3600;
  const BUDGET = ethers.parseEther("70000");

  if (Number(info.periodFinish_) > Math.floor(Date.now() / 1000)) {
    await (await farm.connect(owner).cancelDrip()).wait();
  }
  await (await farm.connect(owner).setRewardsDuration(WINDOW)).wait();
  await (await reward.connect(owner).approve(record.farm, BUDGET)).wait();
  await (await farm.connect(owner).fundAndStart(BUDGET)).wait();

  info = await farm.farmInfo();
  ok("window is 7 days", info.rewardsDuration_ === BigInt(WINDOW));
  ok("farm holds the budget", info.rewardBalance_ >= BUDGET, `${eth(info.rewardBalance_)} TRWD`);
  ok("drip is streaming", info.rewardRate_ > 0n, `${eth(info.rewardRate_ * 86400n)} TRWD/day`);
  ok("nothing over-committed", info.rewardBalance_ >= info.outstanding_ + info.scheduled_);

  // ------------------------------------------------------------------ stake --
  step(3, "Two wallets approve and stake (what the farm site does)");
  const aliceIds = (await nft.ownedIds(alice.address)).map(String);
  const bobIds = (await nft.ownedIds(bob.address)).map(String);
  if (aliceIds.length < 2 || bobIds.length < 1) {
    throw new Error("Test wallets have no NFTs — re-run `npm run deploy:local`.");
  }

  await (await nft.connect(alice).setApprovalForAll(record.farm, true)).wait();
  await (await nft.connect(bob).setApprovalForAll(record.farm, true)).wait();

  const aliceStake = aliceIds.slice(0, 2);
  const bobStake = bobIds.slice(0, 1);
  await (await farm.connect(alice).stake(aliceStake)).wait();
  await (await farm.connect(bob).stake(bobStake)).wait();

  ok("3 NFTs on the tarmac", (await farm.totalStaked()) === 3n);
  ok("2 pilots on the roster", (await farm.stakerCount()) === 2n);
  for (const id of aliceStake) {
    ok(`NFT #${id} held by the farm`, (await nft.ownerOf(id)) === record.farm);
    ok(`NFT #${id} credited to alice`, (await farm.stakerOf(id)) === alice.address);
  }

  // ----------------------------------------------------------------- accrue --
  step(4, "Advance one day and check the split");
  await advance(24 * 3600);

  const aliceEarned = await farm.earned(alice.address);
  const bobEarned = await farm.earned(bob.address);
  const dayTotal = (await farm.rewardRate()) * 86400n;
  ok("alice earns ~2/3", aliceEarned > (dayTotal * 64n) / 100n && aliceEarned < (dayTotal * 69n) / 100n, `${eth(aliceEarned)}`);
  ok("bob earns ~1/3", bobEarned > (dayTotal * 31n) / 100n && bobEarned < (dayTotal * 36n) / 100n, `${eth(bobEarned)}`);
  ok("alice earns exactly 2x bob", aliceEarned / bobEarned === 2n);

  // ------------------------------------------------------------------ claim --
  step(5, "Alice claims");
  const before = await reward.balanceOf(alice.address);
  await (await farm.connect(alice).getReward()).wait();
  const got = (await reward.balanceOf(alice.address)) - before;
  ok("alice was paid", got >= aliceEarned, `${eth(got)} TRWD`);
  ok("alice's pending resets", (await farm.earned(alice.address)) < ethers.parseEther("1"));
  ok("her NFTs stay staked", (await farm.stakedBalanceOf(alice.address)) === 2n);

  // --------------------------------------------------------------- withdraw --
  step(6, "Alice withdraws one NFT; the exact id comes back");
  const rare = aliceStake[0];
  await (await farm.connect(alice).withdraw([rare])).wait();
  ok(`NFT #${rare} returned to alice`, (await nft.ownerOf(rare)) === alice.address);
  ok("stake count drops to 2", (await farm.totalStaked()) === 2n);
  ok("alice keeps her other NFT", (await farm.stakedBalanceOf(alice.address)) === 1n);

  // -------------------------------------------------------------- pause/exit --
  step(7, "Owner pauses staking — exits must still work");
  await (await farm.connect(owner).setStakingPaused(true)).wait();
  let blocked = false;
  try {
    await farm.connect(alice).stake([rare]);
  } catch {
    blocked = true;
  }
  ok("new stakes are blocked", blocked);

  await advance(WINDOW);
  await (await farm.connect(bob).exit()).wait();
  ok("bob's NFT came home", (await nft.ownerOf(bobStake[0])) === bob.address);
  ok("bob was paid on exit", (await reward.balanceOf(bob.address)) > 0n);

  await (await farm.connect(owner).setStakingPaused(false)).wait();
  ok("staking reopened", !(await farm.stakingPaused()));

  // ------------------------------------------------------------- rescue math --
  step(8, "Solvency and rescue guards");
  info = await farm.farmInfo();
  ok("farm still solvent", info.rewardBalance_ >= info.outstanding_);

  let guarded = false;
  try {
    await farm.connect(owner).recoverERC20(record.mocks.nft, 1);
  } catch {
    guarded = true;
  }
  ok("staking token can never be recovered", guarded);

  guarded = false;
  try {
    await farm.connect(owner).recoverERC721(record.mocks.nft, aliceStake[1], owner.address);
  } catch {
    guarded = true;
  }
  ok("a staked NFT can never be recovered", guarded);

  // ------------------------------------------------------------- final exit --
  step(9, "Everyone out");
  await (await farm.connect(alice).exit()).wait();
  ok("farm is empty", (await farm.totalStaked()) === 0n);
  ok("no pilots left", (await farm.stakerCount()) === 0n);
  for (const id of [...aliceStake, ...bobStake]) {
    const holder = await nft.ownerOf(id);
    ok(`NFT #${id} is with its owner`, holder === alice.address || holder === bob.address);
  }

  info = await farm.farmInfo();
  console.log(`\nLeftover in the farm: ${eth(info.rewardBalance_)} TRWD  (owed: ${eth(info.outstanding_)})`);
  console.log(`\n✔ ${checks} checks passed — the deployed farm behaves end to end.`);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
});
