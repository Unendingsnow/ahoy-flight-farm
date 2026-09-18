// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @dev Minimal interface for the NFT collection — an ERC-721, or the NFT side of
 *      an ERC-404. `transferFrom` is declared void-returning (ERC-721 style) so
 *      this works whether the real contract returns a bool or nothing; extra
 *      return data is simply ignored.
 */
interface INftCollection {
    function transferFrom(address from, address to, uint256 amountOrId) external;
    function ownerOf(uint256 id) external view returns (address);
}

/**
 * @title NftStakeFarm
 * @notice Stake the NFT side of a collection — deposit your actual NFTs (specific
 *         tokenIds) and earn a reward token. Withdrawing returns the exact
 *         same NFTs.
 *
 *         REWARD MODEL — hard, budgeted drip (Synthetix `StakingRewards`):
 *         the owner funds a fixed amount of reward token and streams it over a
 *         fixed window. That total is a HARD CAP — split pro-rata across
 *         whatever NFTs are staked, second by second.
 *           - Whole collection staked => each NFT earns budget / collectionSize.
 *           - Fewer NFTs staked       => each staked NFT earns a bigger share.
 *           - Total emitted           => never exceeds the funded budget.
 *
 *         LATE BINDING: both the NFT collection and the reward token are set
 *         AFTER deployment by the owner (see `setStakingToken` /
 *         `setRewardsToken`). This lets the same farm be deployed first and
 *         pointed at the real collection + real reward token once those addresses
 *         are known. Both setters are hard-gated so they can never strand a
 *         staker's NFT or silently repay debts in the wrong denomination.
 *
 * @dev    Reward accounting is the audited Synthetix accumulator with stake
 *         weight = number of NFTs staked (each NFT = 1 share). O(1) per user.
 *
 *         404 safety: NFTs are pulled by specific id via transferFrom and each
 *         is verified to have actually landed in the farm (guards against any
 *         404 "reroll"). For gas efficiency the farm should be set ERC-721
 *         transfer-exempt on the collection, but it is correct either way.
 *
 *         Fee-on-transfer reward tokens are supported: `fund()` credits the
 *         amount actually received, and the solvency check in
 *         `notifyRewardAmount` reads the real balance. If the farm is NOT tax
 *         exempt on the reward token, stakers simply receive the post-tax
 *         amount — internal accounting stays exact either way.
 *
 *         Compiled for the `shanghai` EVM (no Cancun-only opcodes) so it is safe
 *         to deploy on PulseChain.
 */
contract NftStakeFarm is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ----------------------------------------------------------------------
    // Configuration (late-bound)
    // ----------------------------------------------------------------------

    /// @notice NFT collection whose tokens are staked. Set post-deploy.
    INftCollection public stakingToken;
    /// @notice ERC-20 paid out as rewards. Set post-deploy.
    IERC20 public rewardsToken;

    /// @notice When true, new stakes are blocked. Withdrawing and claiming are
    ///         NEVER blocked — stakers can always get their NFTs back.
    bool public stakingPaused;

    // ----------------------------------------------------------------------
    // Drip state
    // ----------------------------------------------------------------------

    /// @notice Timestamp the current drip window ends.
    uint256 public periodFinish;
    /// @notice Reward wei streamed per second in total (split across staked NFTs).
    uint256 public rewardRate;
    /// @notice Length of a drip window. Defaults to 10 years (3650 days).
    uint256 public rewardsDuration = 3650 days;
    /// @notice Last time reward accounting was updated.
    uint256 public lastUpdateTime;
    /// @notice Accumulated reward per staked NFT (scaled by 1e18).
    uint256 public rewardPerTokenStored;

    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    /// @notice Bumped every time the reward token changes. Accruals from an
    ///         older epoch are dropped rather than repaid in a different token.
    uint256 public rewardEpoch = 1;
    /// @notice Last epoch each account's reward ledger was synced to.
    mapping(address => uint256) public userRewardEpoch;

    /// @notice Total rewards streamed into the accumulator this epoch. Slightly
    ///         over-counts (by per-second truncation dust), so every solvency
    ///         check built on it errs on the safe side.
    uint256 public totalDistributed;
    /// @notice Total rewards claimed this epoch.
    uint256 public totalClaimed;

    // ----------------------------------------------------------------------
    // Stake state
    // ----------------------------------------------------------------------

    /// @notice Number of NFTs currently staked across all users (the share base).
    uint256 public totalStaked;
    /// @notice Number of distinct addresses with at least one NFT staked.
    uint256 public stakerCount;

    /// @notice Which user staked a given tokenId (address(0) if not staked here).
    mapping(uint256 => address) public stakerOf;

    // Per-user set of staked tokenIds (array + index for O(1) swap-pop removal).
    mapping(address => uint256[]) private _stakedList;
    mapping(uint256 => uint256) private _stakedIndex;

    // ----------------------------------------------------------------------
    // Events
    // ----------------------------------------------------------------------

    event Staked(address indexed user, uint256[] tokenIds);
    event Withdrawn(address indexed user, uint256[] tokenIds);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardAdded(uint256 reward, uint256 rewardRate, uint256 periodFinish);
    event DripToppedUp(uint256 amount, uint256 rewardRate, uint256 periodFinish);
    event RewardsDurationUpdated(uint256 newDuration);
    event Funded(address indexed from, uint256 amount);
    event DripCancelled(uint256 returnedToUnallocated);
    event StakingTokenUpdated(address indexed previous, address indexed current);
    event RewardsTokenUpdated(
        address indexed previous,
        address indexed current,
        uint256 newEpoch,
        uint256 droppedLiability
    );
    event StakingPausedUpdated(bool paused);
    event RecoveredERC20(address indexed token, uint256 amount, address indexed to);
    event RecoveredERC721(address indexed token, uint256 tokenId, address indexed to);
    event EmergencyUnstaked(address indexed user, uint256[] tokenIds);
    event EmergencyUnstakeDisabled();

    // ----------------------------------------------------------------------
    // Constructor
    // ----------------------------------------------------------------------

    /**
     * @param _owner         Farm owner (configures tokens, funds the drip).
     * @param _rewardsToken  Reward token, or address(0) to set it later.
     * @param _stakingToken  NFT collection address, or address(0) to set it later.
     */
    constructor(address _owner, address _rewardsToken, address _stakingToken) Ownable(_owner) {
        if (_rewardsToken != address(0)) {
            rewardsToken = IERC20(_rewardsToken);
            emit RewardsTokenUpdated(address(0), _rewardsToken, rewardEpoch, 0);
        }
        if (_stakingToken != address(0)) {
            require(_stakingToken != _rewardsToken, "same token");
            stakingToken = INftCollection(_stakingToken);
            emit StakingTokenUpdated(address(0), _stakingToken);
        }
    }

    // ----------------------------------------------------------------------
    // Reward math (per staked NFT)
    // ----------------------------------------------------------------------

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) {
            return rewardPerTokenStored;
        }
        return
            rewardPerTokenStored +
            ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * 1e18) / totalStaked;
    }

    /// @notice Rewards earned but not yet claimed by `account`.
    function earned(address account) public view returns (uint256) {
        // An account that has not been synced to the current reward epoch has
        // no claim in the current reward token.
        if (userRewardEpoch[account] != rewardEpoch) {
            return 0;
        }
        uint256 count = _stakedList[account].length;
        return
            (count * (rewardPerToken() - userRewardPerTokenPaid[account])) /
            1e18 +
            rewards[account];
    }

    /// @notice Total rewards that will be paid over the full current window.
    function getRewardForDuration() external view returns (uint256) {
        return rewardRate * rewardsDuration;
    }

    /// @notice Rewards already earned by stakers but not yet claimed. These are
    ///         a hard liability — the owner can never recover them.
    function outstandingRewards() public view returns (uint256) {
        uint256 distributed = totalDistributed;
        // Include accrual since the last checkpoint so the figure is live.
        uint256 applicable = lastTimeRewardApplicable();
        if (totalStaked > 0 && applicable > lastUpdateTime) {
            distributed += (applicable - lastUpdateTime) * rewardRate;
        }
        return distributed > totalClaimed ? distributed - totalClaimed : 0;
    }

    /// @notice Rewards promised to the rest of the current drip window but not
    ///         yet streamed.
    function scheduledRewards() public view returns (uint256) {
        return block.timestamp < periodFinish ? (periodFinish - block.timestamp) * rewardRate : 0;
    }

    /// @notice Reward-token balance not owed to anyone: free to re-notify or
    ///         recover. `balance - outstanding - scheduled`, floored at 0.
    function unallocatedRewards() public view returns (uint256) {
        if (address(rewardsToken) == address(0)) return 0;
        uint256 balance = rewardsToken.balanceOf(address(this));
        uint256 committed = outstandingRewards() + scheduledRewards();
        return balance > committed ? balance - committed : 0;
    }

    modifier updateReward(address account) {
        _updateReward(account);
        _;
    }

    function _updateReward(address account) internal {
        uint256 applicable = lastTimeRewardApplicable();
        if (totalStaked > 0 && applicable > lastUpdateTime) {
            totalDistributed += (applicable - lastUpdateTime) * rewardRate;
        }
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = applicable;

        if (account != address(0)) {
            if (userRewardEpoch[account] != rewardEpoch) {
                // First touch in this epoch: start from a clean slate so an
                // accrual denominated in a previous reward token is never paid
                // out in the new one.
                rewards[account] = 0;
                userRewardEpoch[account] = rewardEpoch;
            } else {
                rewards[account] = earned(account);
            }
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
    }

    // ----------------------------------------------------------------------
    // Views
    // ----------------------------------------------------------------------

    /// @notice Number of NFTs `account` currently has staked.
    function stakedBalanceOf(address account) public view returns (uint256) {
        return _stakedList[account].length;
    }

    /// @notice The exact tokenIds `account` has staked.
    function stakedTokens(address account) external view returns (uint256[] memory) {
        return _stakedList[account];
    }

    /// @notice Reward tokens currently held by the farm.
    function rewardBalance() public view returns (uint256) {
        if (address(rewardsToken) == address(0)) return 0;
        return rewardsToken.balanceOf(address(this));
    }

    /// @notice True once both tokens are wired up and the farm can take stakes.
    function isConfigured() public view returns (bool) {
        return address(stakingToken) != address(0) && address(rewardsToken) != address(0);
    }

    /// @notice Everything the UI needs about the farm in a single call.
    function farmInfo()
        external
        view
        returns (
            address stakingToken_,
            address rewardsToken_,
            uint256 totalStaked_,
            uint256 stakerCount_,
            uint256 rewardRate_,
            uint256 periodFinish_,
            uint256 rewardsDuration_,
            uint256 rewardBalance_,
            uint256 outstanding_,
            uint256 scheduled_,
            uint256 unallocated_,
            bool paused_,
            uint256 epoch_
        )
    {
        return (
            address(stakingToken),
            address(rewardsToken),
            totalStaked,
            stakerCount,
            rewardRate,
            periodFinish,
            rewardsDuration,
            rewardBalance(),
            outstandingRewards(),
            scheduledRewards(),
            unallocatedRewards(),
            stakingPaused,
            rewardEpoch
        );
    }

    /// @notice Everything the UI needs about one wallet in a single call.
    function userInfo(address account)
        external
        view
        returns (uint256[] memory staked, uint256 earned_, uint256 perSecond)
    {
        staked = _stakedList[account];
        earned_ = earned(account);
        // This wallet's current share of the stream, in reward wei per second.
        perSecond = totalStaked == 0 || block.timestamp >= periodFinish
            ? 0
            : (rewardRate * staked.length) / totalStaked;
    }

    // ----------------------------------------------------------------------
    // Internal staked-id set
    // ----------------------------------------------------------------------

    function _addStake(address user, uint256 id) internal {
        _stakedList[user].push(id);
        _stakedIndex[id] = _stakedList[user].length - 1;
        stakerOf[id] = user;
    }

    function _removeStake(address user, uint256 id) internal {
        uint256[] storage list = _stakedList[user];
        uint256 idx = _stakedIndex[id];
        uint256 lastIdx = list.length - 1;
        if (idx != lastIdx) {
            uint256 lastId = list[lastIdx];
            list[idx] = lastId;
            _stakedIndex[lastId] = idx;
        }
        list.pop();
        delete _stakedIndex[id];
        delete stakerOf[id];
    }

    // ----------------------------------------------------------------------
    // Staker actions
    // ----------------------------------------------------------------------

    /**
     * @notice Stake NFTs by tokenId. Requires the farm to be approved on
     *         the collection first (setApprovalForAll(farm, true), or approve per id).
     */
    function stake(uint256[] calldata tokenIds) external nonReentrant updateReward(msg.sender) {
        require(isConfigured(), "Farm not configured");
        require(!stakingPaused, "Staking paused");
        uint256 n = tokenIds.length;
        require(n > 0, "No token ids");

        if (_stakedList[msg.sender].length == 0) {
            stakerCount += 1;
        }

        INftCollection nft = stakingToken;
        for (uint256 i = 0; i < n; i++) {
            uint256 id = tokenIds[i];
            require(stakerOf[id] == address(0), "Already staked");
            nft.transferFrom(msg.sender, address(this), id);
            // The exact id must now be held here — reverts on any 404 reroll /
            // mis-transfer so a rare NFT can never be silently swapped or lost.
            require(nft.ownerOf(id) == address(this), "id not received");
            _addStake(msg.sender, id);
        }
        totalStaked += n;
        emit Staked(msg.sender, tokenIds);
    }

    /// @notice Withdraw specific staked NFTs back to yourself. Never blocked.
    function withdraw(uint256[] memory tokenIds) public nonReentrant updateReward(msg.sender) {
        uint256 n = tokenIds.length;
        require(n > 0, "No token ids");

        INftCollection nft = stakingToken;
        for (uint256 i = 0; i < n; i++) {
            uint256 id = tokenIds[i];
            require(stakerOf[id] == msg.sender, "Not your stake");
            _removeStake(msg.sender, id);
            nft.transferFrom(address(this), msg.sender, id);
        }
        totalStaked -= n;
        if (_stakedList[msg.sender].length == 0) {
            stakerCount -= 1;
        }
        emit Withdrawn(msg.sender, tokenIds);
    }

    /// @notice Claim accrued rewards.
    function getReward() public nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            totalClaimed += reward;
            rewardsToken.safeTransfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
    }

    /// @notice Withdraw every staked NFT and claim rewards in one call.
    function exit() external {
        uint256[] memory ids = _stakedList[msg.sender];
        if (ids.length > 0) {
            withdraw(ids);
        }
        getReward();
    }

    // ----------------------------------------------------------------------
    // Funding & drip control
    // ----------------------------------------------------------------------

    /**
     * @notice Top up the farm's reward reserve (pulls from caller). Anyone may
     *         fund. Call `notifyRewardAmount` afterwards to (re)start the drip.
     * @return received The amount that actually landed, after any transfer tax.
     */
    function fund(uint256 amount) public nonReentrant returns (uint256 received) {
        require(address(rewardsToken) != address(0), "Reward token unset");
        require(amount > 0, "Cannot fund 0");
        uint256 before = rewardsToken.balanceOf(address(this));
        rewardsToken.safeTransferFrom(msg.sender, address(this), amount);
        received = rewardsToken.balanceOf(address(this)) - before;
        require(received > 0, "Nothing received");
        emit Funded(msg.sender, received);
    }

    /**
     * @notice Fund and immediately stream everything unallocated. One-click
     *         start for the admin panel; equivalent to `fund` then
     *         `notifyRewardAmount(unallocatedRewards())`.
     */
    function fundAndStart(uint256 amount) external onlyOwner {
        fund(amount);
        _notifyRewardAmount(unallocatedRewards());
    }

    /**
     * @notice Start (or extend) the drip. Fund the farm first, then call with
     *         the total amount to stream over `rewardsDuration`.
     *
     *         Any reward still un-streamed from a running window is rolled into
     *         the new rate, so nothing is lost when topping up.
     */
    function notifyRewardAmount(uint256 reward) external onlyOwner {
        _notifyRewardAmount(reward);
    }

    function _notifyRewardAmount(uint256 reward) internal updateReward(address(0)) {
        require(address(rewardsToken) != address(0), "Reward token unset");
        require(reward > 0, "Nothing to stream");

        if (block.timestamp >= periodFinish) {
            rewardRate = reward / rewardsDuration;
        } else {
            uint256 remaining = periodFinish - block.timestamp;
            uint256 leftover = remaining * rewardRate;
            rewardRate = (reward + leftover) / rewardsDuration;
        }
        require(rewardRate > 0, "Reward rate = 0");

        // The farm must hold enough reward token to honour the new rate on top
        // of everything it already owes to stakers, so the drip can never be
        // over-committed and a claim can never bounce.
        uint256 balance = rewardsToken.balanceOf(address(this));
        uint256 owed = outstandingRewards();
        uint256 available = balance > owed ? balance - owed : 0;
        require(rewardRate <= available / rewardsDuration, "Provided reward too high");

        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + rewardsDuration;
        emit RewardAdded(reward, rewardRate, periodFinish);
    }

    /**
     * @notice Fold unallocated reward into the CURRENT window, leaving
     *         `periodFinish` exactly where it is.
     *
     *         This is the counterpart to `notifyRewardAmount`, which always
     *         restarts a full `rewardsDuration` from the moment it is called —
     *         fine when opening a window, wrong when you only want to recycle a
     *         surplus. The classic source of that surplus is time the farm spent
     *         with nothing staked: emissions keep running against the clock, no
     *         one accrues them, and they land in `unallocatedRewards()`. Putting
     *         them back through `notifyRewardAmount` would push the end date out
     *         by however long the window has already been running.
     *
     *         Raises the rate for the remaining time only:
     *         `rewardRate += amount / (periodFinish - now)`.
     */
    function addToDrip(uint256 amount) external onlyOwner updateReward(address(0)) {
        require(address(rewardsToken) != address(0), "Reward token unset");
        require(block.timestamp < periodFinish, "No active window");
        require(amount > 0, "Nothing to add");
        require(amount <= unallocatedRewards(), "Exceeds unallocated rewards");

        uint256 remaining = periodFinish - block.timestamp;
        // Integer division: an amount smaller than the seconds left cannot move
        // the rate at all. Reverting beats reporting a top-up that did nothing.
        uint256 rateDelta = amount / remaining;
        require(rateDelta > 0, "Amount too small for window");
        rewardRate += rateDelta;

        // Same solvency rule as notifyRewardAmount, measured against the time
        // actually left rather than a fresh full duration.
        uint256 balance = rewardsToken.balanceOf(address(this));
        uint256 owed = outstandingRewards();
        uint256 available = balance > owed ? balance - owed : 0;
        require(rewardRate <= available / remaining, "Provided reward too high");

        lastUpdateTime = block.timestamp;
        emit DripToppedUp(amount, rewardRate, periodFinish);
    }

    /**
     * @notice Stop the drip now. Everything already earned stays owed to
     *         stakers; the un-streamed remainder becomes unallocated and can be
     *         re-notified or recovered.
     */
    function cancelDrip() external onlyOwner updateReward(address(0)) {
        uint256 returned = scheduledRewards();
        rewardRate = 0;
        periodFinish = block.timestamp;
        emit DripCancelled(returned);
    }

    /// @notice Change the drip window length. Only allowed between windows.
    function setRewardsDuration(uint256 _rewardsDuration) external onlyOwner {
        require(block.timestamp >= periodFinish, "Period not finished");
        require(_rewardsDuration > 0, "Duration = 0");
        rewardsDuration = _rewardsDuration;
        emit RewardsDurationUpdated(_rewardsDuration);
    }

    // ----------------------------------------------------------------------
    // Late-bound configuration
    // ----------------------------------------------------------------------

    /**
     * @notice Point the farm at the NFT collection. Only allowed
     *         while nothing is staked, so no staker's NFT can ever be stranded
     *         behind a swapped address.
     */
    function setStakingToken(address token) external onlyOwner {
        require(token != address(0), "zero token");
        require(token != address(rewardsToken), "same token");
        require(totalStaked == 0, "NFTs still staked");
        address previous = address(stakingToken);
        require(previous != token, "Unchanged");
        stakingToken = INftCollection(token);
        emit StakingTokenUpdated(previous, token);
    }

    /**
     * @notice Point the farm at the reward token. Only allowed while nothing is
     *         staked and no drip is running.
     *
     *         Changing the token opens a new reward epoch: any rewards earned
     *         but unclaimed under the OLD token are dropped rather than silently
     *         repaid out of the new token's budget (`outstandingRewards()`
     *         reports that figure before you switch — settle it first if it
     *         matters). Leftover balance of the old token is returned to the
     *         owner in the same transaction.
     */
    function setRewardsToken(address token) external onlyOwner {
        require(token != address(0), "zero token");
        require(token != address(stakingToken), "same token");
        require(totalStaked == 0, "NFTs still staked");
        require(block.timestamp >= periodFinish, "Drip running");

        address previous = address(rewardsToken);
        require(previous != token, "Unchanged");

        uint256 dropped = outstandingRewards();

        // Sweep whatever is left of the old token back to the owner.
        if (previous != address(0)) {
            uint256 leftover = IERC20(previous).balanceOf(address(this));
            if (leftover > 0) {
                IERC20(previous).safeTransfer(owner(), leftover);
            }
        }

        rewardsToken = IERC20(token);
        rewardEpoch += 1;
        totalDistributed = 0;
        totalClaimed = 0;
        rewardRate = 0;
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp;

        emit RewardsTokenUpdated(previous, token, rewardEpoch, dropped);
    }

    /// @notice Block new stakes. Withdrawing and claiming always stay open.
    function setStakingPaused(bool paused) external onlyOwner {
        stakingPaused = paused;
        emit StakingPausedUpdated(paused);
    }

    // ----------------------------------------------------------------------
    // Emergency unstake
    // ----------------------------------------------------------------------

    /**
     * EVICT, NEVER SEIZE.
     *
     * The owner can push stakers out of the farm so a bug here can never trap
     * anyone's NFT. The destination is always `stakerOf[id]` — it is read from
     * storage, never passed in — so this returns property to its owner and can
     * do nothing else. A compromised owner key can empty the farm; it cannot
     * take a single NFT.
     *
     * Deliberately independent of the reward token: nothing is transferred but
     * NFTs, and earned rewards are checkpointed into `rewards[]` for the staker
     * to claim later. A reward token that is paused, blacklisting, or simply
     * broken therefore cannot block the rescue — which is the whole point of
     * having one.
     *
     * Staking must be paused first, so this is a declared emergency rather than
     * something that can be done quietly, and nobody can re-stake into the farm
     * being drained.
     */

    /// @notice Set once to give up these powers forever. One-way.
    bool public emergencyUnstakeDisabled;

    function _emergencyUnstake(address user, uint256 maxCount) internal returns (uint256 moved) {
        _updateReward(user);

        uint256[] storage list = _stakedList[user];
        uint256 n = list.length;
        if (n == 0) return 0;
        if (maxCount == 0 || maxCount > n) maxCount = n;

        INftCollection nft = stakingToken;
        uint256[] memory ids = new uint256[](maxCount);
        for (uint256 i = 0; i < maxCount; i++) {
            // Take from the tail: with swap-pop removal that avoids the swap.
            uint256 id = list[list.length - 1];
            ids[i] = id;
            _removeStake(user, id);
            nft.transferFrom(address(this), user, id);
        }

        totalStaked -= maxCount;
        if (list.length == 0) stakerCount -= 1;
        emit EmergencyUnstaked(user, ids);
        return maxCount;
    }

    /**
     * @notice Return one staker's NFTs to them and clear their stake.
     * @param maxCount Cap on how many to move in this call, so a wallet holding
     *                 hundreds cannot exceed the block gas limit. 0 means all.
     */
    function emergencyUnstake(address user, uint256 maxCount) external onlyOwner nonReentrant {
        require(!emergencyUnstakeDisabled, "Emergency unstake disabled");
        require(stakingPaused, "Pause staking first");
        require(_emergencyUnstake(user, maxCount) > 0, "Nothing staked");
    }

    /**
     * @notice The same, across a list of stakers. Addresses come from the
     *         `Staked` event log — the farm keeps no enumerable staker set, so
     *         that stays off-chain rather than taxing every stake and withdraw.
     *         Wallets with nothing staked are skipped, so the list can be stale.
     */
    function emergencyUnstakeMany(address[] calldata users, uint256 maxPerUser)
        external
        onlyOwner
        nonReentrant
    {
        require(!emergencyUnstakeDisabled, "Emergency unstake disabled");
        require(stakingPaused, "Pause staking first");
        require(users.length > 0, "No users");
        for (uint256 i = 0; i < users.length; i++) {
            _emergencyUnstake(users[i], maxPerUser);
        }
    }

    /**
     * @notice Give up the emergency powers permanently. Irreversible.
     *         Once the farm has proven itself, this is how the owner proves
     *         they cannot touch a staked NFT ever again.
     */
    function disableEmergencyUnstake() external onlyOwner {
        emergencyUnstakeDisabled = true;
        emit EmergencyUnstakeDisabled();
    }

    // ----------------------------------------------------------------------
    // Rescue
    // ----------------------------------------------------------------------

    /**
     * @notice Rescue ERC-20s sent here by mistake. The staking token can never
     *         be pulled (it backs staked NFTs), and the reward token only down
     *         to the unallocated surplus — rewards already earned or scheduled
     *         are untouchable. Use `cancelDrip()` first to free the schedule.
     */
    function recoverERC20(address token, uint256 amount) external onlyOwner {
        require(token != address(stakingToken), "Cannot recover staking token");
        if (token == address(rewardsToken)) {
            require(amount <= unallocatedRewards(), "Exceeds unallocated rewards");
        }
        IERC20(token).safeTransfer(owner(), amount);
        emit RecoveredERC20(token, amount, owner());
    }

    /// @notice Rescue an ERC-721/404 NFT sent here by mistake. An actively
    ///         staked NFT can NEVER be pulled out this way.
    function recoverERC721(address token, uint256 tokenId, address to) external onlyOwner {
        require(to != address(0), "zero to");
        if (token == address(stakingToken)) {
            require(stakerOf[tokenId] == address(0), "Token is staked");
        }
        INftCollection(token).transferFrom(address(this), to, tokenId);
        emit RecoveredERC721(token, tokenId, to);
    }

    /// @dev Reject direct safe-transfers — deposits must go through stake() so
    ///      they are accounted for. Prevents NFTs getting stranded here.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert("Use stake() to deposit");
    }
}
