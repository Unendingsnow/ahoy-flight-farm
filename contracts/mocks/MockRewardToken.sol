// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockRewardToken
 * @notice Stand-in for the live reward token while it does not exist yet.
 *         Mirrors its stated tokenomics so the farm can be tested against the
 *         real behaviour locally:
 *
 *           - 1% burn        on buys/sells
 *           - 1% to "omega"  on buys/sells
 *           - 1% to treasury on buys/sells (buy-back wallet)
 *
 *         "Buy/sell" means any transfer where one side is a registered AMM
 *         pair. Wallet-to-wallet transfers, and anything involving a tax-exempt
 *         address, are untaxed — which is how the farm's drip and payouts stay
 *         whole once the farm is exempted.
 *
 * @dev    TEST DOUBLE ONLY — never deploy to production. `taxAllTransfers`
 *         exists purely so the test suite can prove the farm's accounting also
 *         survives a reward token that taxes *every* transfer.
 */
contract MockRewardToken is ERC20, Ownable {
    uint256 public constant BPS = 10_000;
    /// @notice Total tax can never exceed 10%.
    uint256 public constant MAX_TOTAL_BPS = 1_000;

    uint256 public burnBps = 100; // 1% burned
    uint256 public omegaBps = 100; // 1% to omega
    uint256 public treasuryBps = 100; // 1% to treasury / buy-backs

    address public omegaWallet;
    address public treasuryWallet;

    /// @notice Registered AMM pairs — a transfer touching one is a buy or sell.
    mapping(address => bool) public isAmmPair;
    /// @notice Addresses that never pay tax (the farm, the treasury, the owner).
    mapping(address => bool) public isTaxExempt;

    /// @notice Test-only switch: tax every transfer, not just buys/sells.
    bool public taxAllTransfers;

    event TaxesUpdated(uint256 burnBps, uint256 omegaBps, uint256 treasuryBps);
    event TaxExemptUpdated(address indexed account, bool exempt);
    event AmmPairUpdated(address indexed pair, bool isPair);
    event TaxTaken(address indexed from, address indexed to, uint256 burned, uint256 omega, uint256 treasury);

    constructor(
        string memory name_,
        string memory symbol_,
        address owner_,
        uint256 initialSupply,
        address omega_,
        address treasury_
    ) ERC20(name_, symbol_) Ownable(owner_) {
        require(omega_ != address(0) && treasury_ != address(0), "zero wallet");
        omegaWallet = omega_;
        treasuryWallet = treasury_;
        isTaxExempt[owner_] = true;
        isTaxExempt[omega_] = true;
        isTaxExempt[treasury_] = true;
        _mint(owner_, initialSupply);
    }

    // ---- admin ----

    function setTaxes(uint256 burnBps_, uint256 omegaBps_, uint256 treasuryBps_) external onlyOwner {
        require(burnBps_ + omegaBps_ + treasuryBps_ <= MAX_TOTAL_BPS, "tax too high");
        burnBps = burnBps_;
        omegaBps = omegaBps_;
        treasuryBps = treasuryBps_;
        emit TaxesUpdated(burnBps_, omegaBps_, treasuryBps_);
    }

    function setTaxExempt(address account, bool exempt) external onlyOwner {
        isTaxExempt[account] = exempt;
        emit TaxExemptUpdated(account, exempt);
    }

    function setAmmPair(address pair, bool state) external onlyOwner {
        isAmmPair[pair] = state;
        emit AmmPairUpdated(pair, state);
    }

    function setTaxAllTransfers(bool state) external onlyOwner {
        taxAllTransfers = state;
    }

    function setWallets(address omega_, address treasury_) external onlyOwner {
        require(omega_ != address(0) && treasury_ != address(0), "zero wallet");
        omegaWallet = omega_;
        treasuryWallet = treasury_;
    }

    /// @notice Test helper so a local run can top up a wallet without a DEX.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    // ---- views ----

    function totalTaxBps() public view returns (uint256) {
        return burnBps + omegaBps + treasuryBps;
    }

    /// @notice Whether a given transfer would be taxed, and by how much.
    function quoteTax(address from, address to, uint256 value)
        public
        view
        returns (uint256 burnAmt, uint256 omegaAmt, uint256 treasuryAmt, uint256 net)
    {
        if (!_isTaxed(from, to)) {
            return (0, 0, 0, value);
        }
        burnAmt = (value * burnBps) / BPS;
        omegaAmt = (value * omegaBps) / BPS;
        treasuryAmt = (value * treasuryBps) / BPS;
        net = value - burnAmt - omegaAmt - treasuryAmt;
    }

    function _isTaxed(address from, address to) internal view returns (bool) {
        if (from == address(0) || to == address(0)) return false; // mint / burn
        if (isTaxExempt[from] || isTaxExempt[to]) return false;
        if (totalTaxBps() == 0) return false;
        return taxAllTransfers || isAmmPair[from] || isAmmPair[to];
    }

    // ---- transfer hook ----

    function _update(address from, address to, uint256 value) internal override {
        if (!_isTaxed(from, to)) {
            super._update(from, to, value);
            return;
        }

        (uint256 burnAmt, uint256 omegaAmt, uint256 treasuryAmt, uint256 net) = quoteTax(from, to, value);

        if (burnAmt > 0) super._update(from, address(0), burnAmt);
        if (omegaAmt > 0) super._update(from, omegaWallet, omegaAmt);
        if (treasuryAmt > 0) super._update(from, treasuryWallet, treasuryAmt);
        super._update(from, to, net);

        emit TaxTaken(from, to, burnAmt, omegaAmt, treasuryAmt);
    }
}
