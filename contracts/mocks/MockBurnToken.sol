// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockBurnToken (BURN)
 * @notice FIXED-supply, SELF-BURNING reward token used as a test double.
 *
 *         - Fixed supply: the whole supply is minted once at deploy. There is
 *           NO mint function, so supply can never be inflated — only reduced.
 *         - Self-burning: a small % of every ordinary transfer is burned, so
 *           circulating supply depletes over time as the token changes hands.
 *
 *         Exemptions: addresses on the exempt list neither pay nor trigger the
 *           burn. The treasury and the staking farm are exempted so that (a)
 *           funding the farm and (b) paying stakers their exact earned rewards
 *           are never taxed. Deflation therefore comes from trading/normal
 *           transfers, not from the reward drip itself.
 *
 *         Intended launch allocation (35,000,000 total):
 *           - 30,000,000  -> the farm, dripped to stakers over ~10 years
 *           -  5,000,000  -> treasury / liquidity
 */
contract MockBurnToken is ERC20, ERC20Burnable, Ownable {
    /// @notice Hard cap and intended launch supply: 35,000,000 BURN.
    uint256 public constant MAX_SUPPLY = 35_000_000 ether;
    /// @notice Upper bound on the burn fee: 10% (1000 bps). Owner can't exceed it.
    uint256 public constant MAX_BURN_BPS = 1_000;

    /// @notice Burn fee on ordinary transfers, in basis points (100 = 1%).
    uint256 public burnBps = 100;

    /// @notice Addresses exempt from the transfer burn (both as sender & receiver).
    mapping(address => bool) public isBurnExempt;

    event BurnBpsUpdated(uint256 newBurnBps);
    event BurnExemptUpdated(address indexed account, bool exempt);

    /**
     * @param treasury       Owner + receiver of the entire minted supply. Auto-exempt.
     * @param initialSupply  Amount minted at deploy (<= MAX_SUPPLY). Real launch: 35_000_000 ether.
     */
    constructor(address treasury, uint256 initialSupply) ERC20("Burn Token", "BURN") Ownable(treasury) {
        require(treasury != address(0), "zero treasury");
        require(initialSupply <= MAX_SUPPLY, "exceeds max supply");
        isBurnExempt[treasury] = true;
        _mint(treasury, initialSupply);
    }

    /// @notice Set the transfer burn fee (bps). Capped at MAX_BURN_BPS.
    function setBurnBps(uint256 newBurnBps) external onlyOwner {
        require(newBurnBps <= MAX_BURN_BPS, "burn too high");
        burnBps = newBurnBps;
        emit BurnBpsUpdated(newBurnBps);
    }

    /// @notice Add/remove an address from the burn exemption list (e.g. the farm, LP).
    function setBurnExempt(address account, bool exempt) external onlyOwner {
        isBurnExempt[account] = exempt;
        emit BurnExemptUpdated(account, exempt);
    }

    /**
     * @dev Applies the self-burn on ordinary transfers. Mints, burns, a zero
     *      fee, or any exempt party pass through untouched.
     */
    function _update(address from, address to, uint256 value) internal override {
        if (
            from == address(0) || // mint
            to == address(0) ||   // burn
            burnBps == 0 ||
            isBurnExempt[from] ||
            isBurnExempt[to]
        ) {
            super._update(from, to, value);
            return;
        }

        uint256 fee = (value * burnBps) / 10_000;
        if (fee > 0) {
            super._update(from, address(0), fee); // burn the fee (reduces totalSupply)
        }
        super._update(from, to, value - fee); // deliver the remainder
    }
}
