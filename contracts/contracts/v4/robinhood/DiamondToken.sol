// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title DiamondToken
/// @notice Fixed-supply launchpad token with the diamond curve: every wallet
///         carries a weighted "acquired at" clock, and selling early pays a
///         decaying jeet tax in coin on top of the pool's flat fee:
///
///           held < 1h  -> +9%      held < 6h -> +4%
///           held < 24h -> +1.5%    held >= 24h -> +0
///
///         The tax is skimmed on transfers into taxed sinks (the router and
///         the PoolManager, i.e. sells), pooled in the token, and swept by the
///         hook at harvest, where it is converted to WETH and distributed to
///         every remaining holder through the MasterChef-style dividend
///         tracker below. Jeets pay diamond hands, in ETH.
///
///         Moving coins to another wallet resets that wallet's clock to now,
///         so the tax cannot be dodged by hopping wallets. Buys and plain
///         wallet transfers are never taxed.
contract DiamondToken is ERC20 {
    using SafeERC20 for IERC20;

    uint256 private constant ACC_PRECISION = 1e24;
    uint16 private constant JEET_1H_BPS = 900;
    uint16 private constant JEET_6H_BPS = 400;
    uint16 private constant JEET_24H_BPS = 150;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice Wallet credited as the token's creator (immutable attribution).
    address public immutable creator;
    /// @notice The hook allowed to credit dividends; set once by the factory.
    address public hook;
    /// @notice Immutable per-token trade tax in basis points (pool-side fee).
    uint16 public immutable taxBps;
    /// @notice Currency dividends are paid in (the pair token, WETH here).
    address public immutable rewardToken;

    /// @dev Accumulated reward per eligible share, scaled by ACC_PRECISION.
    uint256 private accRewardPerShare;
    /// @dev Supply eligible for dividends (excludes system/excluded holders).
    uint256 public eligibleSupply;
    /// @dev Reward already accounted to a holder: balance * acc / PRECISION.
    mapping(address => uint256) private rewardDebt;
    /// @dev Settled-but-unclaimed rewards per holder.
    mapping(address => uint256) public claimable;
    /// @dev Addresses that do not participate in dividends (pool, system).
    mapping(address => bool) public excluded;
    /// @notice Transfers INTO these addresses are sells and pay the jeet tax.
    mapping(address => bool) public taxedSink;
    /// @notice Weighted average acquire time per wallet (the diamond clock).
    mapping(address => uint64) public acquiredAt;
    /// @notice Coin collected from early sellers, awaiting the next harvest.
    uint256 public jeetPot;

    /// @notice Lifetime rewards distributed to holders, in reward units.
    uint256 public totalRewardsDistributed;

    string private _metadataURI;

    event HookSet(address indexed hook);
    event ExcludedSet(address indexed account, bool excluded);
    event RewardsDistributed(uint256 amount);
    event RewardsClaimed(address indexed holder, uint256 amount);
    event JeetTaxed(address indexed seller, uint256 amount, uint16 rateBps);

    error OnlyFactory();
    error OnlyHook();
    error HookAlreadySet();
    error WrongRewardCurrency();

    address private immutable _factory;

    constructor(
        string memory name_,
        string memory symbol_,
        string memory metadataURI_,
        uint256 supply_,
        address creator_,
        address supplyRecipient_,
        uint16 taxBps_,
        address rewardToken_,
        address factoryAuth_
    ) ERC20(name_, symbol_) {
        require(taxBps_ <= 1000, "tax>10%");
        _factory = factoryAuth_;
        creator = creator_;
        taxBps = taxBps_;
        rewardToken = rewardToken_;
        _metadataURI = metadataURI_;

        // Exclude system endpoints from dividends up front, so rewards only
        // ever flow to real holders. The dead address is excluded too: burned
        // wall dust must not dilute holder payouts.
        excluded[address(0)] = true;
        excluded[address(this)] = true;
        excluded[supplyRecipient_] = true;
        excluded[DEAD] = true;

        _mint(supplyRecipient_, supply_);
    }

    /// @notice Off-chain metadata JSON (description, logo, website, socials).
    function metadataURI() external view returns (string memory) {
        return _metadataURI;
    }

    /// @notice Burn tokens held by the caller.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Factory wiring (one-time)
    // ---------------------------------------------------------------------

    /// @notice Wire the hook, exclude the pool/system addresses, and register
    ///         the sell sinks. The factory calls this exactly once.
    function initHook(address hook_, address[] calldata excludedAddrs, address[] calldata sinks) external {
        if (msg.sender != _factory) revert OnlyFactory();
        if (hook != address(0)) revert HookAlreadySet();
        hook = hook_;
        emit HookSet(hook_);
        _setExcluded(hook_, true);
        for (uint256 i; i < excludedAddrs.length; ++i) {
            _setExcluded(excludedAddrs[i], true);
        }
        for (uint256 i; i < sinks.length; ++i) {
            taxedSink[sinks[i]] = true;
        }
    }

    // ---------------------------------------------------------------------
    // Diamond curve
    // ---------------------------------------------------------------------

    /// @notice The extra sell tax this wallet would pay right now, in bps.
    function sellTaxBpsOf(address holder) public view returns (uint16) {
        uint64 t = acquiredAt[holder];
        if (t == 0) return 0; // never bought (or system address)
        uint256 age = block.timestamp - t;
        if (age < 1 hours) return JEET_1H_BPS;
        if (age < 6 hours) return JEET_6H_BPS;
        if (age < 24 hours) return JEET_24H_BPS;
        return 0;
    }

    /// @notice Pull the accumulated jeet pot to the hook for conversion and
    ///         distribution. Only the hook, at harvest.
    function sweepJeetPot() external returns (uint256 amount) {
        if (msg.sender != hook) revert OnlyHook();
        amount = jeetPot;
        if (amount == 0) return 0;
        jeetPot = 0;
        _move(address(this), hook, amount);
    }

    // ---------------------------------------------------------------------
    // Dividend distribution
    // ---------------------------------------------------------------------

    /// @notice Credit an ERC-20 reward distribution to all eligible holders.
    ///         The hook must have transferred `amount` of `rewardToken` here
    ///         before calling. No-op-safe when there is no eligible supply.
    function distributeRewards(uint256 amount) external {
        if (msg.sender != hook) revert OnlyHook();
        if (rewardToken == address(0)) revert WrongRewardCurrency();
        _distribute(amount);
    }

    /// @notice Credit a native reward distribution to all eligible holders.
    function distributeRewardsNative() external payable {
        if (msg.sender != hook) revert OnlyHook();
        if (rewardToken != address(0)) revert WrongRewardCurrency();
        _distribute(msg.value);
    }

    function _distribute(uint256 amount) private {
        uint256 supply = eligibleSupply;
        if (amount == 0 || supply == 0) return;
        accRewardPerShare += (amount * ACC_PRECISION) / supply;
        totalRewardsDistributed += amount;
        emit RewardsDistributed(amount);
    }

    /// @notice Pending, not-yet-settled rewards for a holder.
    function pendingRewards(address holder) public view returns (uint256) {
        if (excluded[holder]) return claimable[holder];
        uint256 accrued = (balanceOf(holder) * accRewardPerShare) / ACC_PRECISION;
        uint256 debt = rewardDebt[holder];
        uint256 extra = accrued > debt ? accrued - debt : 0;
        return claimable[holder] + extra;
    }

    /// @notice Claim all settled + pending rewards to the caller.
    function claim() external returns (uint256 amount) {
        return _claimTo(msg.sender);
    }

    /// @notice Push a holder's accrued rewards to THEIR wallet. Callable by
    ///         anyone (the keeper), but funds only ever go to the holder.
    function claimFor(address holder) external returns (uint256 amount) {
        return _claimTo(holder);
    }

    /// @notice Batch delivery for the keeper.
    function claimForMany(address[] calldata holders) external {
        for (uint256 i; i < holders.length; ++i) {
            try this.claimFor(holders[i]) {} catch {}
        }
    }

    function _claimTo(address holder) private returns (uint256 amount) {
        _settle(holder);
        amount = claimable[holder];
        if (amount == 0) return 0;
        claimable[holder] = 0;
        emit RewardsClaimed(holder, amount);
        if (rewardToken == address(0)) {
            (bool ok, ) = payable(holder).call{value: amount}("");
            require(ok, "native xfer");
        } else {
            IERC20(rewardToken).safeTransfer(holder, amount);
        }
    }

    // ---------------------------------------------------------------------
    // Accounting
    // ---------------------------------------------------------------------

    function _settle(address account) private {
        if (account == address(0) || excluded[account]) return;
        uint256 accrued = (balanceOf(account) * accRewardPerShare) / ACC_PRECISION;
        uint256 debt = rewardDebt[account];
        if (accrued > debt) claimable[account] += accrued - debt;
        rewardDebt[account] = accrued;
    }

    function _resetDebt(address account) private {
        rewardDebt[account] = (balanceOf(account) * accRewardPerShare) / ACC_PRECISION;
    }

    function _setExcluded(address account, bool value) private {
        if (excluded[account] == value) return;
        uint256 bal = balanceOf(account);
        if (value) {
            _settle(account);
            if (bal != 0) eligibleSupply -= bal;
        } else {
            if (bal != 0) eligibleSupply += bal;
            _resetDebt(account);
        }
        excluded[account] = value;
        emit ExcludedSet(account, value);
    }

    /// @dev Transfer entry point. Splits off the jeet tax when a real wallet
    ///      sells into a taxed sink; everything else moves untouched.
    function _update(address from, address to, uint256 value) internal override {
        if (value != 0 && from != address(0) && !excluded[from] && taxedSink[to]) {
            uint16 rate = sellTaxBpsOf(from);
            if (rate != 0) {
                uint256 tax = (value * rate) / 10_000;
                if (tax != 0) {
                    jeetPot += tax;
                    emit JeetTaxed(from, tax, rate);
                    _move(from, address(this), tax);
                    _move(from, to, value - tax);
                    return;
                }
            }
        }
        _move(from, to, value);
    }

    /// @dev Core move: settles both sides, applies the balance change, keeps
    ///      `eligibleSupply` in sync, rebases reward debt, and advances the
    ///      receiving wallet's diamond clock (weighted by amount).
    function _move(address from, address to, uint256 value) private {
        bool fromEligible = from != address(0) && !excluded[from];
        bool toEligible = to != address(0) && !excluded[to];

        if (fromEligible) _settle(from);
        if (toEligible) _settle(to);

        super._update(from, to, value);

        if (fromEligible && !toEligible) {
            eligibleSupply -= value;
        } else if (!fromEligible && toEligible) {
            eligibleSupply += value;
        }

        if (fromEligible) _resetDebt(from);
        if (toEligible) _resetDebt(to);

        // Diamond clock: any receive re-weights the wallet's acquire time
        // toward now, so wallet-hopping always resets the tax to maximum.
        if (toEligible && value != 0) {
            uint256 nb = balanceOf(to);
            uint256 prev = nb - value;
            acquiredAt[to] = uint64((prev * uint256(acquiredAt[to]) + value * block.timestamp) / nb);
        }
    }

    /// @notice Accept native only as reward funding.
    receive() external payable {}
}
