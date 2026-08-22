require("@nomicfoundation/hardhat-toolbox");
const fs = require("fs");
const path = require("path");

/**
 * Minimal .env reader.
 *
 * Deliberately dependency-free (no `dotenv`) so the project keeps its
 * zero-extra-deps posture, and because the key in this repo's .env is
 * `Deployer-PK` — a hyphenated name that shell-style loaders often mangle.
 *
 * Accepts, in order of preference: PRIVATE_KEY, DEPLOYER_PK, Deployer-PK.
 */
function readEnvFile() {
  const file = path.join(__dirname, ".env");
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const ENV = readEnvFile();

/** Normalises a private key to the 0x-prefixed form ethers expects. */
function deployerKey() {
  const raw =
    process.env.PRIVATE_KEY ||
    process.env.DEPLOYER_PK ||
    ENV.PRIVATE_KEY ||
    ENV.DEPLOYER_PK ||
    ENV["Deployer-PK"] ||
    "";
  const k = raw.trim();
  if (!k) return null;
  const hex = k.startsWith("0x") ? k : `0x${k}`;
  return /^0x[0-9a-fA-F]{64}$/.test(hex) ? hex : null;
}

const KEY = deployerKey();
const ACCOUNTS = KEY ? [KEY] : [];

/** Public PulseChain RPCs. Override with PULSE_RPC to use your own node. */
const PULSE_RPC = process.env.PULSE_RPC || "https://rpc.pulsechain.com";
const PULSE_TESTNET_RPC =
  process.env.PULSE_TESTNET_RPC || "https://rpc-testnet-pulsechain.g4mm4.io";

/**
 * Hardhat config for PulseChain.
 *
 * PulseChain is a full Ethereum fork, but it has NOT adopted Cancun — the
 * `mcopy` / transient-storage opcodes are unavailable. `evmVersion: "shanghai"`
 * is therefore load-bearing, not a preference: bumping it produces bytecode that
 * reverts on chain. (It is also why the ERC-721 mock is hand-written instead of
 * inheriting OpenZeppelin 5.6, whose `Strings`/`Bytes` use `mcopy`.)
 *
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "shanghai",
    },
  },
  networks: {
    // Unit tests run here on chainId 943. `npm run battletest` sets FORK=1,
    // which re-points this network at real PulseChain mainnet state and makes
    // it report chainId 369 so the rehearsal is faithful.
    //
    // `chains` is required when forking PulseChain: Hardhat ships hardfork
    // activation history only for chains it knows, and without it every call
    // against a historical block fails with "No known hardfork". PulseChain has
    // been on Shanghai since genesis from this config's point of view — it has
    // NOT adopted Cancun, which is why `hardfork` is pinned to shanghai too.
    hardhat: {
      chainId: process.env.FORK ? 369 : 943,
      hardfork: "shanghai",
      forking: process.env.FORK
        ? {
            url: PULSE_RPC,
            blockNumber: process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : undefined,
          }
        : undefined,
      chains: {
        369: { hardforkHistory: { shanghai: 0 } },
        943: { hardforkHistory: { shanghai: 0 } },
      },
    },
    // A local `hardhat node`.
    localPulse: {
      url: "http://127.0.0.1:8545",
      chainId: 943,
    },
    // A local `hardhat node --fork <PULSE_RPC>`: real mainnet state, fake money.
    pulseFork: {
      url: "http://127.0.0.1:8545",
      chainId: 943,
    },
    // --- Live ---
    pulsechain: {
      url: PULSE_RPC,
      chainId: 369,
      accounts: ACCOUNTS,
    },
    pulsechainTestnet: {
      url: PULSE_TESTNET_RPC,
      chainId: 943,
      accounts: ACCOUNTS,
    },
  },
};

module.exports.deployerKeyPresent = Boolean(KEY);
