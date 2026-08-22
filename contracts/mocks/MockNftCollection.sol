// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title MockNftCollection
 * @notice Minimal but faithful ERC-404 used to test the farm locally against
 *         real 404 mechanics: transferring whole tokens mints/burns NFTs, and
 *         "transfer-exempt" (whitelisted) addresses skip NFT churn.
 *
 *         This mirrors the classic Pandora/ERC404-v1 behaviour that a 404 collection is
 *         built on. It is a TEST DOUBLE only — do not deploy to production.
 *
 * @dev    transferFrom(from, to, amountOrId): if `amountOrId` <= number of NFTs
 *         minted it is treated as an NFT id transfer, otherwise as an ERC-20
 *         value transfer. The farm always moves >= 1e18, so it is never
 *         ambiguous in practice.
 */
contract MockNftCollection {
    // ---- ERC-20 metadata ----
    string public name = "Mock NFT Collection";
    string public symbol = "MOCKNFT";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    // ---- ERC-20 state ----
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // ---- ERC-721 state ----
    uint256 public minted; // running counter of NFT ids ever minted
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    mapping(address => uint256[]) internal _owned;      // tokenIds held per address
    mapping(uint256 => uint256) internal _ownedIndex;   // tokenId => index in _owned[owner]

    // ---- 404 config ----
    address public owner;
    /// @notice Addresses exempt from NFT mint/burn on transfer (e.g. pools/farms).
    mapping(address => bool) public whitelist;

    // ERC-20 & ERC-721 share this signature (the classic 404 quirk).
    event Transfer(address indexed from, address indexed to, uint256 amountOrId);
    event Approval(address indexed owner, address indexed spender, uint256 amountOrId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor(uint256 initialSupply) {
        owner = msg.sender;
        // Deployer is whitelisted so minting the initial ERC-20 supply does not
        // spin up thousands of NFTs (matches how 404 projects seed liquidity).
        whitelist[msg.sender] = true;
        balanceOf[msg.sender] = initialSupply;
        totalSupply = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    function _unit() internal pure returns (uint256) {
        return 10 ** decimals;
    }

    // ---- admin ----
    function setWhitelist(address account, bool state) external {
        require(msg.sender == owner, "not owner");
        whitelist[account] = state;
    }

    // ---- ERC-721 views ----
    function tokenURI(uint256 id) public pure returns (string memory) {
        return string(abi.encodePacked("https://mock.example/metadata/", _toString(id), ".json"));
    }

    function ownedIds(address account) external view returns (uint256[] memory) {
        return _owned[account];
    }

    // ---- ERC-20 / ERC-721 approvals ----
    function approve(address spender, uint256 amountOrId) public returns (bool) {
        if (amountOrId <= minted && amountOrId > 0) {
            // ERC-721 approve
            address tokenOwner = ownerOf[amountOrId];
            require(
                msg.sender == tokenOwner || isApprovedForAll[tokenOwner][msg.sender],
                "not authorized"
            );
            getApproved[amountOrId] = spender;
            emit Approval(tokenOwner, spender, amountOrId);
        } else {
            // ERC-20 approve
            allowance[msg.sender][spender] = amountOrId;
            emit Approval(msg.sender, spender, amountOrId);
        }
        return true;
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    // ---- transfers ----
    function transferFrom(address from, address to, uint256 amountOrId) public returns (bool) {
        if (amountOrId <= minted && amountOrId > 0) {
            // ERC-721 transfer of a specific tokenId
            require(from == ownerOf[amountOrId], "wrong from");
            require(to != address(0), "zero to");
            require(
                msg.sender == from ||
                    isApprovedForAll[from][msg.sender] ||
                    msg.sender == getApproved[amountOrId],
                "not authorized"
            );

            // move one whole token of ERC-20 value alongside the NFT
            balanceOf[from] -= _unit();
            balanceOf[to] += _unit();

            _transferNFT(from, to, amountOrId);
            delete getApproved[amountOrId];

            emit Transfer(from, to, amountOrId);
            return true;
        }

        // ERC-20 transfer
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amountOrId, "insufficient allowance");
            allowance[from][msg.sender] = allowed - amountOrId;
        }
        return _transferERC20(from, to, amountOrId);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transferERC20(msg.sender, to, amount);
    }

    function _transferERC20(address from, address to, uint256 amount) internal returns (bool) {
        require(to != address(0), "zero to");
        uint256 unit = _unit();

        uint256 balBeforeFrom = balanceOf[from];
        uint256 balBeforeTo = balanceOf[to];

        require(balBeforeFrom >= amount, "insufficient balance");
        balanceOf[from] = balBeforeFrom - amount;
        balanceOf[to] = balBeforeTo + amount;

        // Burn NFTs from sender as their whole-token count drops.
        if (!whitelist[from]) {
            uint256 burnCount = (balBeforeFrom / unit) - (balanceOf[from] / unit);
            for (uint256 i = 0; i < burnCount; i++) {
                _burnNFT(from);
            }
        }

        // Mint NFTs to receiver as their whole-token count rises.
        if (!whitelist[to]) {
            uint256 mintCount = (balanceOf[to] / unit) - (balBeforeTo / unit);
            for (uint256 i = 0; i < mintCount; i++) {
                _mintNFT(to);
            }
        }

        emit Transfer(from, to, amount);
        return true;
    }

    // ---- NFT bookkeeping ----
    function _mintNFT(address to) internal {
        unchecked {
            minted++;
        }
        uint256 id = minted;
        ownerOf[id] = to;
        _owned[to].push(id);
        _ownedIndex[id] = _owned[to].length - 1;
        emit Transfer(address(0), to, id);
    }

    function _burnNFT(address from) internal {
        uint256[] storage owned = _owned[from];
        uint256 lastIndex = owned.length - 1;
        uint256 id = owned[lastIndex]; // burn most-recently-acquired id
        owned.pop();
        delete _ownedIndex[id];
        delete ownerOf[id];
        delete getApproved[id];
        emit Transfer(from, address(0), id);
    }

    function _transferNFT(address from, address to, uint256 id) internal {
        // remove from `from`
        uint256[] storage fromOwned = _owned[from];
        uint256 idx = _ownedIndex[id];
        uint256 lastIndex = fromOwned.length - 1;
        if (idx != lastIndex) {
            uint256 lastId = fromOwned[lastIndex];
            fromOwned[idx] = lastId;
            _ownedIndex[lastId] = idx;
        }
        fromOwned.pop();

        // add to `to`
        ownerOf[id] = to;
        _owned[to].push(id);
        _ownedIndex[id] = _owned[to].length - 1;
    }

    // ---- util ----
    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
