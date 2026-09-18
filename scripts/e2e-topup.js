/**
 * End-to-end rehearsal of `addToDrip` against a running node (`npm run node`).
 *
 * The unit tests run against a freshly compiled contract in-process. This one
 * drives the DEPLOYED bytecode over JSON-RPC, in the same order the admin panel
 * fires its calls, so the ABI the site ships is proven against the chain.
 *
 *   terminal 1:  npm run node
 *   terminal 2:  npm run deploy:local
 *   terminal 2:  npx hardhat run scripts/e2e-topup.js --network localPulse
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const RECORD = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
const DAY = 86400;

let checks = 0;
function ok(label, condition, detail = "") {
  checks += 1;
  if (!condition) throw new Error(`FAILED: ${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ok  ${label}${detail ? `  (${detail})` : ""}`);
}
const f = (v, d = 18) =>
  Number(ethers.formatUnits(v, d)).toLocaleString("en-US", { maximumFractionDigits: 4 });

async function jump(seconds) {
  await hre.network.provider.send("evm_increaseTime", [seconds]);
  await hre.network.provider.send("evm_mine", []);
}
async function now() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

async function main() {
  const rec = JSON.parse(fs.readFileSync(RECORD, "utf8"));
  const [owner, alice] = await ethers.getSigners();

  // Load through the ABI the WEBSITE ships, not the artifact — if the panel
  // could not call this, the test must fail too.
  const abiFile = fs.readFileSync(path.join(__dirname, "..", "web", "abi.js"), "utf8");
  const abi = JSON.parse(abiFile.match(/window\.FARM_ABI\s*=\s*([\s\S]*?);\s*$/)[1]);
  ok("site ABI exposes addToDrip", JSON.stringify(abi.farm).includes("addToDrip"));

  const farm = new ethers.Contract(rec.farm, abi.farm, owner);

  // The record is written at deploy time, before the farm is wired — so read the
  // token addresses off the farm, which is the only source that cannot go stale.
  const wired = await farm.farmInfo();
  const nftAddr = wired.stakingToken_ !== ethers.ZeroAddress
    ? wired.stakingToken_
    : (rec.mocks && rec.mocks.nft) || rec.stakingToken;
  const rewardAddr = wired.rewardsToken_ !== ethers.ZeroAddress
    ? wired.rewardsToken_
    : (rec.mocks && rec.mocks.reward) || rec.rewardsToken;
  const nft = await ethers.getContractAt("MockNftCollection", nftAddr);
  const reward = await ethers.getContractAt("MockRewardToken", rewardAddr);
  console.log(`  farm ${rec.farm}\n  nft  ${nftAddr}\n  rwd  ${rewardAddr}`);

  if (wired.stakingToken_ === ethers.ZeroAddress) {
    await (await farm.setStakingToken(nftAddr)).wait();
    await (await farm.setRewardsToken(rewardAddr)).wait();
    await (await nft.setWhitelist(rec.farm, true)).wait();
  }

  console.log("\n1. Open a fresh 100-day window");
  await (await reward.setTaxExempt(rec.farm, true)).wait();
  // A previous rehearsal may have left a window open; setRewardsDuration is
  // only legal between windows.
  if ((await farm.periodFinish()) > BigInt(await now())) {
    await (await farm.cancelDrip()).wait();
  }
  await (await farm.setRewardsDuration(100 * DAY)).wait();
  await (await reward.approve(rec.farm, ethers.parseEther("10000000"))).wait();
  await (await farm.fund(ethers.parseEther("1000000"))).wait();
  await (await farm.notifyRewardAmount(await farm.unallocatedRewards())).wait();
  const finish0 = await farm.periodFinish();
  ok("drip running", (await farm.rewardRate()) > 0n);

  console.log("\n2. Let it sit empty — this is what mints the surplus");
  // This node may carry debt from an earlier rehearsal on the same farm, so the
  // claim is that idle time adds NOTHING to it — not that it starts at zero.
  const owedBefore = await farm.outstandingRewards();
  await jump(20 * DAY);
  const surplus = await farm.unallocatedRewards();
  ok("surplus accrued while nobody was staked", surplus > ethers.parseEther("190000"),
    `${f(surplus)} TRWD`);
  ok("nobody earned it", (await farm.outstandingRewards()) === owedBefore,
    `outstanding held at ${f(owedBefore)}`);

  console.log("\n3. Alice stakes, then the owner recycles the surplus");
  const ids = (await nft.ownedIds(owner.address)).slice(0, 2).map((x) => x.toString());
  await (await nft.transfer(alice.address, ethers.parseEther("2"))).wait();
  const aliceIds = (await nft.ownedIds(alice.address)).map((x) => x.toString());
  await (await nft.connect(alice).setApprovalForAll(rec.farm, true)).wait();
  await (await farm.connect(alice).stake([aliceIds[0]])).wait();

  const rateBefore = await farm.rewardRate();
  const remaining = finish0 - BigInt(await now()) - 1n; // the tx itself mines a second

  const rcpt = await (await farm.addToDrip(surplus)).wait();
  const rateAfter = await farm.rewardRate();

  ok("periodFinish did not move", (await farm.periodFinish()) === finish0);
  ok("rate rose", rateAfter > rateBefore, `${f(rateBefore)} -> ${f(rateAfter)} /s`);
  ok("rate rose by ~surplus/remaining",
    rateAfter - rateBefore >= (surplus / remaining) - 2n &&
      rateAfter - rateBefore <= (surplus / remaining) + 2n);
  ok("surplus consumed", (await farm.unallocatedRewards()) < ethers.parseEther("1"));
  ok("DripToppedUp emitted",
    rcpt.logs.some((l) => {
      try { return farm.interface.parseLog(l).name === "DripToppedUp"; } catch { return false; }
    }));

  console.log("\n4. The raised rate is really paid");
  const before = await farm.earned(alice.address);
  await jump(DAY);
  const dayAfter = (await farm.earned(alice.address)) - before;
  const dayAtOldRate = rateBefore * BigInt(DAY);
  ok("a day now pays more than a day at the old rate", dayAfter > dayAtOldRate,
    `${f(dayAfter)} vs ${f(dayAtOldRate)}`);

  console.log("\n5. Guards, over JSON-RPC");
  ok("dust top-up refused",
    await farm.addToDrip(1n).then(() => false, () => true));
  ok("non-owner refused",
    await farm.connect(alice).addToDrip(1000n).then(() => false, () => true));
  ok("over-surplus refused",
    await farm.addToDrip(ethers.parseEther("999999")).then(() => false, () => true));

  console.log("\n6. Solvency, then everybody out");
  const bal = await farm.rewardBalance();
  const committed = (await farm.outstandingRewards()) + (await farm.scheduledRewards());
  ok("balance >= outstanding + scheduled", bal >= committed,
    `${f(bal)} >= ${f(committed)}`);

  const paidBefore = await reward.balanceOf(alice.address);
  await (await farm.connect(alice).exit()).wait();
  ok("alice paid out", (await reward.balanceOf(alice.address)) > paidBefore);
  ok("her NFT came home", (await nft.ownerOf(aliceIds[0])) === alice.address);
  ok("farm empty", (await farm.totalStaked()) === 0n);

  console.log(`\n✔ ${checks} checks passed — addToDrip works end to end on deployed bytecode.\n`);
}

main().catch((e) => {
  console.error("\n" + e.message + "\n");
  process.exitCode = 1;
});
