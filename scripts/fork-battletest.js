/**
 * FULL BATTLE TEST against a PulseChain mainnet FORK.
 *
 *   npm run battletest
 *
 * Real contracts, real state, fake money. This is the rehearsal for the live
 * deploy: it runs the exact call sequence the admin panel and the site will
 * make, against the REAL NFT collection and the REAL reward token, and asserts
 * every step.
 *
 * Because the deployer wallet owns none of the collection, the test impersonates
 * genuine on-chain holders as stakers — so the stake path is exercised with real
 * token ids held by real accounts.
 *
 * It also answers the one thing that cannot be settled by reading code: whether
 * the reward token taxes `fund()` (wallet -> farm) and `getReward()`
 * (farm -> staker). Both are measured as balance deltas.
 */
const hre = require("hardhat");
const { ethers } = hre;
const { TARGETS, MULTICALL3, durationSeconds } = require("./targets");

const CHAIN = 369;
const T = TARGETS[CHAIN];

// The deployed v1 farm — on a fork it is the deepest FLIGHT pocket around, and
// borrowing from it costs nothing because the fork is thrown away.
const LIVE_FARM = "0x71432b22a63F0f14CA43e00fc269809D3570AC00";

const ERC20 = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];
const NFT = [
  "function ownerOf(uint256) view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function setApprovalForAll(address,bool)",
  "function isApprovedForAll(address,address) view returns (bool)",
  "function transferFrom(address,address,uint256)",
];

// ---------------------------------------------------------------- harness --
let pass = 0, fail = 0;
const fails = [];

function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; fails.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
function eq(label, got, want) {
  check(label, got === want, `got ${got}  want ${want}`);
}
/** Assert |got-want| <= tol. */
function near(label, got, want, tol, dec = 18) {
  const d = got > want ? got - want : want - got;
  check(label, d <= tol,
    `got ${ethers.formatUnits(got, dec)}  want ~${ethers.formatUnits(want, dec)}  (diff ${ethers.formatUnits(d, dec)})`);
}
function section(t) { console.log(`\n--- ${t} ---`); }
const E = (n) => ethers.parseEther(String(n));
const f = (v, d = 18) => Number(ethers.formatUnits(v, d)).toLocaleString("en-US", { maximumFractionDigits: 6 });

// 1M PLS of fork-only funny money: PulseChain basefee at the fork block varies
// run to run, and 10k was not always enough to cover an approve + stake.
async function impersonate(addr, pls = "1000000") {
  await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await hre.network.provider.send("hardhat_setBalance", [
    addr, "0x" + ethers.parseEther(pls).toString(16),
  ]);
  return await ethers.getSigner(addr);
}
async function jump(seconds) {
  await hre.network.provider.send("evm_increaseTime", [seconds]);
  await hre.network.provider.send("evm_mine", []);
}
async function chainNow() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

/**
 * Sweep ownerOf across the id range via Multicall3 — the site's discovery path.
 *
 * ADAPTIVE on purpose. This collection's ids are sparse: `totalSupply()` is a
 * count (2833), not a high-water mark, and ~552 tokens sit above that number.
 * Sweeping 1..totalSupply would silently drop a fifth of the collection. So we
 * keep scanning past `expectedEnd` until every token is accounted for, or two
 * consecutive empty chunks suggest we're past the end, or we hit the ceiling.
 */
async function sweepOwners(nftAddr, from, expectedEnd, expectedCount, ceiling) {
  const mc = new ethers.Contract(MULTICALL3, [
    "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[]) view returns (tuple(bool success, bytes returnData)[])",
  ], ethers.provider);
  const iface = new ethers.Interface(["function ownerOf(uint256) view returns (address)"]);
  const owners = new Map();
  const CHUNK = 1000;
  let emptyStreak = 0;

  for (let start = from; start <= ceiling; start += CHUNK) {
    const end = start + CHUNK - 1;
    const calls = [];
    for (let i = start; i <= end; i++) {
      calls.push({ target: nftAddr, allowFailure: true, callData: iface.encodeFunctionData("ownerOf", [i]) });
    }
    const res = await mc.aggregate3.staticCall(calls);
    let found = 0;
    res.forEach((r, i) => {
      if (r.success && r.returnData !== "0x") {
        owners.set(start + i, ethers.getAddress("0x" + r.returnData.slice(26)));
        found++;
      }
    });

    emptyStreak = found === 0 ? emptyStreak + 1 : 0;
    // Done once every token is accounted for and we're past the known range.
    if (expectedCount && owners.size >= expectedCount && end >= expectedEnd) break;
    // Or once the tail is clearly empty.
    if (emptyStreak >= 2 && end >= expectedEnd) break;
  }
  return owners;
}

async function main() {
  const net = await ethers.provider.getNetwork();
  console.log("=".repeat(70));
  console.log("BATTLE TEST — PulseChain mainnet fork");
  console.log("=".repeat(70));
  console.log(`forked chainId ${net.chainId}  block ${await ethers.provider.getBlockNumber()}`);

  if (!hre.config.networks.hardhat.forking) {
    console.log("\nERROR: not running against a fork. Use `npm run battletest` (sets FORK=1).");
    process.exitCode = 1;
    return;
  }

  // Mine one block before touching anything. Immediately after forking, "latest"
  // IS the fork block, and Hardhat treats calls at that height as historical —
  // which needs remote hardfork rules and fails with "No known hardfork". One
  // local block puts "latest" above the fork point so execution stays local.
  await hre.network.provider.send("evm_mine", []);

  const nft = new ethers.Contract(T.nft, NFT, ethers.provider);
  const rwd = new ethers.Contract(T.rewardToken, ERC20, ethers.provider);
  const dec = Number(await rwd.decimals());
  const sym = await rwd.symbol();

  // ------------------------------------------------------------- discovery --
  section("Wallet discovery (Multicall3 ownerOf sweep)");
  const supply = Number(await nft.totalSupply());
  const t0 = Date.now();
  const owners = await sweepOwners(T.nft, T.nftIdStart, T.nftIdEnd, supply, T.nftIdScanCeiling);
  const maxId = Math.max(...owners.keys());
  console.log(`  swept from id ${T.nftIdStart} in ${Date.now() - t0}ms — highest owned id ${maxId}`);
  check("sweep found minted ids", owners.size > 0, `found ${owners.size}`);
  eq("sweep total equals totalSupply()", owners.size, supply);
  check("ids extend past totalSupply (sparse range)", maxId > supply,
    `maxId ${maxId} vs totalSupply ${supply}`);
  const byHolder = new Map();
  for (const [id, o] of owners) {
    if (!byHolder.has(o)) byHolder.set(o, []);
    byHolder.get(o).push(id);
  }
  console.log(`  ${owners.size} minted ids across ${byHolder.size} holders`);
  const ranked = [...byHolder.entries()].sort((a, b) => b[1].length - a[1].length);
  // Cross-check the sweep against ERC-721 balanceOf for the top holders.
  for (const [addr, ids] of ranked.slice(0, 3)) {
    const bal = Number(await nft.balanceOf(addr));
    eq(`sweep matches balanceOf for ${addr.slice(0, 10)}… (${ids.length})`, ids.length, bal);
  }

  // ---------------------------------------------------------------- actors --
  const deployer = await impersonate(T.expectDeployer, "50000");
  const [aliceAddr, aliceIdsAll] = ranked[0];
  const [bobAddr, bobIdsAll] = ranked[1];
  const alice = await impersonate(aliceAddr);
  const bob = await impersonate(bobAddr);
  const aliceIds = aliceIdsAll.slice(0, 3);
  const bobIds = bobIdsAll.slice(0, 2);
  console.log(`\n  deployer ${deployer.address}  ${f(await rwd.balanceOf(deployer.address), dec)} ${sym}`);
  console.log(`  alice    ${aliceAddr}  staking ids ${aliceIds.join(", ")}`);
  console.log(`  bob      ${bobAddr}  staking ids ${bobIds.join(", ")}`);

  // ---------------------------------------------------------------- deploy --
  section("Deploy (bare, exactly as it goes live)");
  const Farm = await ethers.getContractFactory("NftStakeFarm", deployer);
  const farm = await Farm.deploy(deployer.address, ethers.ZeroAddress, ethers.ZeroAddress);
  await farm.waitForDeployment();
  const farmAddr = await farm.getAddress();
  const deployRcpt = await farm.deploymentTransaction().wait();
  console.log(`  farm ${farmAddr}`);
  console.log(`  deploy gas ${deployRcpt.gasUsed}`);
  eq("owner is the deployer", await farm.owner(), deployer.address);
  eq("starts unconfigured", await farm.isConfigured(), false);
  check("stake() blocked while unconfigured",
    await farm.connect(alice).stake([aliceIds[0]]).then(() => false, () => true));

  // ------------------------------------------------------------------ wire --
  section("Wire (the admin-panel sequence)");
  await (await farm.connect(deployer).setStakingToken(T.nft)).wait();
  eq("setStakingToken", await farm.stakingToken(), ethers.getAddress(T.nft));
  await (await farm.connect(deployer).setRewardsToken(T.rewardToken)).wait();
  eq("setRewardsToken", await farm.rewardsToken(), ethers.getAddress(T.rewardToken));
  const DUR = durationSeconds(CHAIN);
  await (await farm.connect(deployer).setRewardsDuration(DUR)).wait();
  eq("setRewardsDuration", await farm.rewardsDuration(), BigInt(DUR));
  eq("now configured", await farm.isConfigured(), true);

  // ------------------------------------------------------------------ fund --
  section(`Fund ${T.budget.toLocaleString()} ${sym} — measuring real transfer tax`);
  const budget = ethers.parseUnits(String(T.budget), dec);

  // The live farm already holds the real budget, so on a fork of today's chain
  // the deployer no longer has it to spend. Borrow the shortfall from the
  // biggest holder — fork-only, and it keeps the rehearsal at full scale
  // instead of silently testing a smaller number than we will deploy.
  let onHand = await rwd.balanceOf(deployer.address);
  if (onHand < budget) {
    const short = budget - onHand;
    // Fork gas is priced off the real chain, so the impersonated account needs a
    // real PLS balance to send anything at all.
    const whale = await impersonate(T.rewardWhale || LIVE_FARM, "10000000");
    const whaleBal = await rwd.balanceOf(await whale.getAddress());
    check(`whale can cover the ${f(short, dec)} ${sym} shortfall`, whaleBal >= short);

    // Send 10% over: if this token taxes transfers, the shortfall would arrive
    // short and the rehearsal would quietly run at less than full scale.
    const send = (short * 110n) / 100n > whaleBal ? whaleBal : (short * 110n) / 100n;
    await (await rwd.connect(whale).transfer(deployer.address, send)).wait();
    onHand = await rwd.balanceOf(deployer.address);
    console.log(`  topped the deployer up by ${f(onHand - (budget - short), dec)} ${sym} (fork only)`);
  }
  check("deployer holds the full budget", onHand >= budget);

  const walletBefore = await rwd.balanceOf(deployer.address);
  await (await rwd.connect(deployer).approve(farmAddr, budget)).wait();
  await (await farm.connect(deployer).fund(budget)).wait();
  const farmGot = await rwd.balanceOf(farmAddr);
  const walletSpent = walletBefore - (await rwd.balanceOf(deployer.address));
  const taxIn = budget - farmGot;
  console.log(`  wallet debited  ${f(walletSpent, dec)} ${sym}`);
  console.log(`  farm received   ${f(farmGot, dec)} ${sym}`);
  console.log(`  TRANSFER TAX IN ${f(taxIn, dec)} ${sym}  (${(Number(taxIn) / Number(budget) * 100).toFixed(4)}%)`);
  check("fund() credited the farm", farmGot > 0n);
  eq("wallet debited exactly the requested amount", walletSpent, budget);
  const TAX_FREE_IN = taxIn === 0n;
  console.log(`  => funding is ${TAX_FREE_IN ? "UNTAXED" : "TAXED"}`);

  // ---------------------------------------------------------------- notify --
  section("Start the drip");
  const unalloc = await farm.unallocatedRewards();
  await (await farm.connect(deployer).notifyRewardAmount(unalloc)).wait();
  const rate = await farm.rewardRate();
  const info0 = await farm.farmInfo();
  console.log(`  rewardRate     ${ethers.formatUnits(rate, dec)} ${sym}/sec`);
  console.log(`  per day        ${f(rate * 86400n, dec)} ${sym}`);
  console.log(`  per year       ${f(rate * 86400n * 365n, dec)} ${sym}`);
  console.log(`  periodFinish   ${new Date(Number(info0.periodFinish_) * 1000).toISOString()}`);
  near("rate ≈ budget / duration", rate, farmGot / BigInt(DUR), 1n);
  check("rewardRate > 0", rate > 0n);
  check("solvent: balance >= outstanding + scheduled",
    (await farm.rewardBalance()) >= (await farm.outstandingRewards()) + (await farm.scheduledRewards()));

  // ----------------------------------------------------------------- stake --
  section("Stake (alice, 3 ids)");
  await (await nft.connect(alice).setApprovalForAll(farmAddr, true)).wait();
  check("approval recorded", await nft.isApprovedForAll(aliceAddr, farmAddr));
  const stakeRcpt = await (await farm.connect(alice).stake(aliceIds)).wait();
  console.log(`  stake gas (3 ids) ${stakeRcpt.gasUsed}`);
  for (const id of aliceIds) eq(`farm holds id ${id}`, await nft.ownerOf(id), farmAddr);
  eq("totalStaked", await farm.totalStaked(), 3n);
  eq("stakerCount", await farm.stakerCount(), 1n);
  eq("stakedBalanceOf(alice)", await farm.stakedBalanceOf(aliceAddr), 3n);
  const aStaked = (await farm.stakedTokens(aliceAddr)).map(Number).sort((a, b) => a - b);
  check("stakedTokens matches", JSON.stringify(aStaked) === JSON.stringify([...aliceIds].sort((a, b) => a - b)),
    `${aStaked} vs ${aliceIds}`);
  check("cannot double-stake an id",
    await farm.connect(alice).stake([aliceIds[0]]).then(() => false, () => true));

  // ---------------------------------------------------------------- accrue --
  section("Accrue — alice is the only staker (should earn 100% of the stream)");
  await jump(86400);
  const earned1 = await farm.earned(aliceAddr);
  console.log(`  earned after 1 day  ${f(earned1, dec)} ${sym}`);
  near("alice earns the whole per-day stream", earned1, rate * 86400n, rate * 5n);

  // ------------------------------------------------------------ two-staker --
  section("Bob stakes 2 — stream must split 3/5 : 2/5");
  await (await nft.connect(bob).setApprovalForAll(farmAddr, true)).wait();
  await (await farm.connect(bob).stake(bobIds)).wait();
  eq("totalStaked", await farm.totalStaked(), 5n);
  eq("stakerCount", await farm.stakerCount(), 2n);
  const aBefore = await farm.earned(aliceAddr);
  await jump(86400);
  const aGain = (await farm.earned(aliceAddr)) - aBefore;
  const bGain = await farm.earned(bobAddr);
  const dayTotal = rate * 86400n;
  console.log(`  alice +${f(aGain, dec)}   bob +${f(bGain, dec)}   day total ${f(dayTotal, dec)}`);
  near("alice earns 3/5 of the day", aGain, (dayTotal * 3n) / 5n, rate * 10n);
  near("bob earns 2/5 of the day", bGain, (dayTotal * 2n) / 5n, rate * 10n);
  near("their gains sum to the day's stream", aGain + bGain, dayTotal, rate * 10n);

  const ui = await farm.userInfo(aliceAddr);
  near("userInfo.perSecond = rate * 3/5", ui.perSecond, (rate * 3n) / 5n, 2n);

  // ----------------------------------------------------------------- claim --
  section("Claim — measuring real payout tax");
  const owedA = await farm.earned(aliceAddr);
  const balA0 = await rwd.balanceOf(aliceAddr);
  await (await farm.connect(alice).getReward()).wait();
  const gotA = (await rwd.balanceOf(aliceAddr)) - balA0;
  const taxOut = owedA > gotA ? owedA - gotA : 0n;
  console.log(`  earned   ${f(owedA, dec)} ${sym}`);
  console.log(`  received ${f(gotA, dec)} ${sym}`);
  console.log(`  PAYOUT TAX ${f(taxOut, dec)} ${sym}  (${owedA > 0n ? (Number(taxOut) / Number(owedA) * 100).toFixed(4) : "0"}%)`);
  check("alice received a payout", gotA > 0n);
  const TAX_FREE_OUT = taxOut === 0n;
  console.log(`  => payouts are ${TAX_FREE_OUT ? "UNTAXED" : "TAXED"}`);
  near("earned resets to ~0 after claim", await farm.earned(aliceAddr), 0n, rate * 3n);

  // -------------------------------------------------------------- withdraw --
  section("Partial withdraw (bob returns 1 of 2)");
  const keep = bobIds[0], give = bobIds[1];
  await (await farm.connect(bob).withdraw([give])).wait();
  eq(`id ${give} back with bob`, await nft.ownerOf(give), bobAddr);
  eq(`id ${keep} still staked`, await nft.ownerOf(keep), farmAddr);
  eq("totalStaked", await farm.totalStaked(), 4n);
  eq("stakerCount still 2", await farm.stakerCount(), 2n);
  check("cannot withdraw someone else's stake",
    await farm.connect(bob).withdraw([aliceIds[0]]).then(() => false, () => true));

  // ------------------------------------------------------------------ exit --
  section("Exit — everyone out, every NFT home");
  await jump(86400);
  await (await farm.connect(alice).exit()).wait();
  await (await farm.connect(bob).exit()).wait();
  for (const id of aliceIds) eq(`alice got back id ${id}`, await nft.ownerOf(id), aliceAddr);
  for (const id of bobIds) eq(`bob got back id ${id}`, await nft.ownerOf(id), bobAddr);
  eq("totalStaked back to 0", await farm.totalStaked(), 0n);
  eq("stakerCount back to 0", await farm.stakerCount(), 0n);

  // ------------------------------------------------------------- solvency --
  section("Solvency invariants");
  const bal = await farm.rewardBalance();
  const outstanding = await farm.outstandingRewards();
  const scheduled = await farm.scheduledRewards();
  const distributed = await farm.totalDistributed();
  const claimed = await farm.totalClaimed();
  console.log(`  balance ${f(bal, dec)} | outstanding ${f(outstanding, dec)} | scheduled ${f(scheduled, dec)}`);
  console.log(`  distributed ${f(distributed, dec)} | claimed ${f(claimed, dec)}`);
  check("balance >= outstanding + scheduled", bal >= outstanding + scheduled);
  check("claimed <= distributed", claimed <= distributed);
  check("claimed <= funded", claimed <= farmGot);
  check("nothing stranded: unallocated is consistent",
    (await farm.unallocatedRewards()) === (bal > outstanding + scheduled ? bal - outstanding - scheduled : 0n));

  // --------------------------------------------------- recycle the surplus --
  // The farm has just sat empty (everyone exited above), so the stream has been
  // running against the clock with nobody to accrue it. That is exactly the
  // surplus addToDrip exists to put back — measured here against the REAL
  // reward token, whose balanceOf the solvency check reads.
  section("addToDrip — recycle idle-time surplus, end date unmoved");
  await jump(14 * 86400);
  await (await nft.connect(alice).setApprovalForAll(farmAddr, true)).wait();
  await (await farm.connect(alice).stake([aliceIds[0]])).wait();

  const surplus = await farm.unallocatedRewards();
  const finishBefore = await farm.periodFinish();
  const rateBefore = await farm.rewardRate();
  const remaining = finishBefore - BigInt(await chainNow());
  console.log(`  surplus ${f(surplus, dec)} ${sym} | ${remaining}s left on the window`);

  check("idle time produced a surplus", surplus > 0n);
  check("a dust top-up is refused rather than silently ignored",
    await farm.connect(deployer).addToDrip(1n).then(() => false, () => true));
  check("a non-owner cannot top up",
    await farm.connect(alice).addToDrip(surplus).then(() => false, () => true));
  check("cannot top up more than the surplus",
    await farm.connect(deployer).addToDrip(surplus + E(1)).then(() => false, () => true));

  const topUpRcpt = await (await farm.connect(deployer).addToDrip(surplus)).wait();
  const rateAfter = await farm.rewardRate();
  // The top-up mines its own block, so the contract divided by the remaining
  // time AT THAT BLOCK — not the one measured a moment earlier.
  const atBlock = BigInt((await ethers.provider.getBlock(topUpRcpt.blockNumber)).timestamp);
  eq("periodFinish unmoved", await farm.periodFinish(), finishBefore);
  check("rate rose", rateAfter > rateBefore);
  eq("rate rose by exactly surplus/remaining",
    rateAfter - rateBefore, surplus / (finishBefore - atBlock));
  check("surplus consumed", (await farm.unallocatedRewards()) < E(1));
  check("still solvent after the top-up",
    (await farm.rewardBalance()) >= (await farm.outstandingRewards()) + (await farm.scheduledRewards()));
  console.log(`  rate ${f(rateBefore, dec)} -> ${f(rateAfter, dec)} /s | gas ${topUpRcpt.gasUsed}`);

  // And the raised rate is really paid out, on the real token.
  const preAccrue = await farm.earned(aliceAddr);
  await jump(86400);
  const dayAfter = (await farm.earned(aliceAddr)) - preAccrue;
  check("a day at the raised rate pays more than a day at the old one",
    dayAfter > (rateBefore * 86400n * 95n) / 100n);
  await (await farm.connect(alice).exit()).wait();
  eq("NFT home after the top-up round", await nft.ownerOf(aliceIds[0]), aliceAddr);

  // --------------------------------------------------------- owner guards --
  section("Owner guards");
  check("recoverERC20 cannot pull the staking token",
    await farm.connect(deployer).recoverERC20(T.nft, 1).then(() => false, () => true));
  check("recoverERC20 cannot exceed unallocated",
    await farm.connect(deployer).recoverERC20(T.rewardToken, bal).then(() => false, () => true));
  check("non-owner cannot notify",
    await farm.connect(alice).notifyRewardAmount(1).then(() => false, () => true));
  check("non-owner cannot pause",
    await farm.connect(alice).setStakingPaused(true).then(() => false, () => true));

  await (await farm.connect(deployer).setStakingPaused(true)).wait();
  check("paused blocks new stakes",
    await farm.connect(alice).stake([aliceIds[0]]).then(() => false, () => true));
  // withdraw/claim must still work while paused
  await (await nft.connect(alice).setApprovalForAll(farmAddr, true)).wait();
  await (await farm.connect(deployer).setStakingPaused(false)).wait();
  await (await farm.connect(alice).stake([aliceIds[0]])).wait();
  await (await farm.connect(deployer).setStakingPaused(true)).wait();
  await jump(3600);
  await (await farm.connect(alice).exit()).wait();
  eq("withdraw works while paused", await nft.ownerOf(aliceIds[0]), aliceAddr);
  await (await farm.connect(deployer).setStakingPaused(false)).wait();

  section("Cancel the drip");
  const schedBefore = await farm.scheduledRewards();
  await (await farm.connect(deployer).cancelDrip()).wait();
  eq("rewardRate zeroed", await farm.rewardRate(), 0n);
  eq("scheduled zeroed", await farm.scheduledRewards(), 0n);
  check("cancelled amount returned to unallocated",
    (await farm.unallocatedRewards()) >= schedBefore - E(1));

  // ---------------------------------------------------------------- report --
  console.log("\n" + "=".repeat(70));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (fail) { console.log("\nFailures:"); fails.forEach((x) => console.log(`  - ${x}`)); }
  console.log("=".repeat(70));
  console.log("\nLIVE-BEHAVIOUR FINDINGS");
  console.log(`  funding tax : ${TAX_FREE_IN ? "NONE — the farm banks the full budget" : `${f(taxIn, dec)} ${sym} skimmed on fund()`}`);
  console.log(`  payout tax  : ${TAX_FREE_OUT ? "NONE — stakers receive exactly what they earned" : `~${(Number(taxOut) / Number(owedA) * 100).toFixed(2)}% skimmed on getReward()`}`);
  console.log(`  deploy gas  : ${deployRcpt.gasUsed}`);
  console.log("");
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
