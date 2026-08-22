/**
 * Cranks the randomised invariant suite across several seeds. Cross-platform
 * (no env-var syntax in package.json), so `npm run test:soak` works the same on
 * Windows and POSIX.
 *
 *   npm run test:soak
 *   FARM_ROUNDS=800 npm run test:soak      (POSIX)
 *   $env:FARM_ROUNDS=800; npm run test:soak (PowerShell)
 */
const { spawnSync } = require("child_process");

const SEEDS = (process.env.FARM_SEEDS || "1,42,999,31337,8675309").split(",");
const ROUNDS = process.env.FARM_ROUNDS || "400";
const isWin = process.platform === "win32";

let failures = 0;
for (const seed of SEEDS) {
  console.log(`\n=== seed ${seed} · ${ROUNDS} rounds ===`);
  const res = spawnSync(
    isWin ? "npx.cmd" : "npx",
    ["hardhat", "test", "test/invariants.test.js"],
    {
      stdio: "inherit",
      env: { ...process.env, FARM_SEED: seed.trim(), FARM_ROUNDS: ROUNDS },
      shell: isWin,
    }
  );
  if (res.status !== 0) failures += 1;
}

console.log(`\n${SEEDS.length - failures}/${SEEDS.length} seeds passed.`);
process.exit(failures === 0 ? 0 : 1);
