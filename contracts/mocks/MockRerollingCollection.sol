// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title MockRerollingCollection
 * @notice A deliberately HOSTILE ERC-404 stand-in: every `transferFrom` burns
 *         the requested tokenId and mints the receiver a brand new one — the
 *         classic 404 "reroll" that silently swaps a rare token for a common one.
 *
 *         Exists only so the test suite can prove `NftStakeFarm.stake()` fails
 *         safe (reverts) instead of accepting a rerolled token.
 *
 * @dev    TEST DOUBLE ONLY.
 */
contract MockRerollingCollection {
    uint256 public minted;
    mapping(uint256 => address) public ownerOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 id);

    function mint(address to) external returns (uint256 id) {
        minted += 1;
        id = minted;
        ownerOf[id] = to;
        emit Transfer(address(0), to, id);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    /// @dev Burns `id`, mints a different id to `to`. `ownerOf(id)` is left at
    ///      address(0), so any caller that verifies delivery will revert.
    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "wrong from");
        require(msg.sender == from || isApprovedForAll[from][msg.sender], "not authorized");
        delete ownerOf[id];
        emit Transfer(from, address(0), id);

        minted += 1;
        ownerOf[minted] = to;
        emit Transfer(address(0), to, minted);
    }
}
