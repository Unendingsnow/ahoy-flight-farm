/**
 * Cross-platform launcher for the mainnet-fork battle test.
 *
 * `FORK=1 hardhat run ...` is a POSIX-ism that breaks under Windows' cmd.exe,
 * which is what npm uses for scripts there. Setting the variable in-process and
 * spawning avoids the shell difference entirely.
 */
const { spawnSync } = require("child_process");

const env = { ...process.env, FORK: "1" };
if (process.argv[2]) env.FORK_BLOCK = process.argv[2];

const r = spawnSync(
  "npx",
  ["hardhat", "run", "scripts/fork-battletest.js"],
  { stdio: "inherit", shell: true, env }
);
process.exit(r.status ?? 1);
