// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title MockPlainERC721
 * @notice A faithful double for the live collection the farm actually points at.
 *
 *         The live collection is a PLAIN ERC-721 despite its "404" name. It
 *         exposes only the ERC-721 core:
 *
 *           name, symbol, totalSupply, balanceOf, ownerOf, tokenURI,
 *           approve, getApproved, setApprovalForAll, isApprovedForAll,
 *           transferFrom, safeTransferFrom
 *
 *         It has NO owner enumeration whatsoever: no `owned()`, `ownedIds()`,
 *         `tokensOfOwner()`, `walletOfOwner()`, and it does NOT implement
 *         ERC721Enumerable, so there is no `tokenOfOwnerByIndex`. It also has
 *         no ERC-20 side — no `decimals()`, no `erc20BalanceOf()`.
 *
 *         That combination is exactly why the site discovers a wallet's tokens
 *         by sweeping `ownerOf` across the id range via Multicall3 instead of
 *         asking the collection to enumerate. This mock keeps that path under
 *         test against the real shape.
 *
 * @dev    Deliberately written WITHOUT OpenZeppelin: OZ 5.6's `Strings`/`Bytes`
 *         use the `mcopy` opcode, which is Cancun-only, and this project pins
 *         `evmVersion: "shanghai"` so it stays deployable on PulseChain.
 *
 *         Token ids run 1..totalSupply (id 0 is never minted), matching the live
 *         collection, where `ownerOf(0)` reverts.
 */
contract MockPlainERC721 {
    string public name = "Mock Plain Collection";
    string public symbol = "MPC";
    string public baseURI = "https://mock.example/metadata/";

    uint256 public totalSupply;
    address public owner;

    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) private _tokenApproval;
    mapping(address => mapping(address => bool)) private _operatorApproval;

    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Approval(address indexed owner, address indexed approved, uint256 indexed id);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor(uint256 initialSupply, address to) {
        owner = msg.sender;
        for (uint256 i = 1; i <= initialSupply; i++) {
            _ownerOf[i] = to;
            emit Transfer(address(0), to, i);
        }
        _balanceOf[to] = initialSupply;
        totalSupply = initialSupply;
    }

    // ------------------------------------------------------------------ views

    function ownerOf(uint256 id) public view returns (address) {
        address o = _ownerOf[id];
        require(o != address(0), "ERC721: invalid token ID");
        return o;
    }

    function balanceOf(address a) external view returns (uint256) {
        require(a != address(0), "ERC721: zero address");
        return _balanceOf[a];
    }

    function tokenURI(uint256 id) external view returns (string memory) {
        ownerOf(id); // reverts if not minted
        return string(abi.encodePacked(baseURI, _toString(id), ".json"));
    }

    function getApproved(uint256 id) external view returns (address) {
        return _tokenApproval[id];
    }

    function isApprovedForAll(address o, address op) public view returns (bool) {
        return _operatorApproval[o][op];
    }

    /// @dev ERC-165: ERC165 + ERC721 + ERC721Metadata. Enumerable is NOT
    ///      supported, exactly like the live collection.
    function supportsInterface(bytes4 iid) external pure returns (bool) {
        return iid == 0x01ffc9a7 || iid == 0x80ac58cd || iid == 0x5b5e139f;
    }

    // --------------------------------------------------------------- approval

    function approve(address to, uint256 id) external {
        address o = ownerOf(id);
        require(msg.sender == o || isApprovedForAll(o, msg.sender), "ERC721: not authorized");
        _tokenApproval[id] = to;
        emit Approval(o, to, id);
    }

    function setApprovalForAll(address op, bool approved) external {
        _operatorApproval[msg.sender][op] = approved;
        emit ApprovalForAll(msg.sender, op, approved);
    }

    // --------------------------------------------------------------- transfer

    function transferFrom(address from, address to, uint256 id) public {
        require(ownerOf(id) == from, "ERC721: wrong from");
        require(to != address(0), "ERC721: transfer to zero");
        require(
            msg.sender == from || _tokenApproval[id] == msg.sender || isApprovedForAll(from, msg.sender),
            "ERC721: not authorized"
        );

        delete _tokenApproval[id];
        _balanceOf[from] -= 1;
        _balanceOf[to] += 1;
        _ownerOf[id] = to;

        emit Transfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        safeTransferFrom(from, to, id, "");
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes memory data) public {
        transferFrom(from, to, id);
        if (to.code.length > 0) {
            bytes4 ret = IERC721Receiver(to).onERC721Received(msg.sender, from, id, data);
            require(ret == IERC721Receiver.onERC721Received.selector, "ERC721: unsafe recipient");
        }
    }

    // ------------------------------------------------------------- test hooks

    /// @notice Mint the next id to `to`. Test helper only.
    function mintTo(address to) external returns (uint256 id) {
        require(msg.sender == owner, "not owner");
        id = ++totalSupply;
        _ownerOf[id] = to;
        _balanceOf[to] += 1;
        emit Transfer(address(0), to, id);
    }

    // ---------------------------------------------------------------- helpers

    function _toString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory buf = new bytes(len);
        while (v != 0) {
            buf[--len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(buf);
    }
}

interface IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}
