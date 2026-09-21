// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IGraduationHandler} from "../../src/interfaces/IGraduationHandler.sol";
import {IHoodFactory} from "../../src/interfaces/IHoodFactory.sol";
import {IHoodFeeRouter} from "../../src/interfaces/IHoodFeeRouter.sol";
import {IHoodToken} from "../../src/interfaces/IHoodToken.sol";
import {PairTransfer} from "../../src/libraries/PairTransfer.sol";
import {Launch} from "../../src/HoodTypes.sol";

/// @notice Stand-in pair asset with six decimals, the shape of a real stablecoin pair.
contract MockUSD is ERC20 {
    constructor() ERC20("Mock Dollar", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockQuote is ERC20 {
    uint8 internal immutable _decimals;

    constructor(string memory symbol_, uint8 decimals_) ERC20("Custom Quote", symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockTaxQuote is MockQuote {
    constructor() MockQuote("TAX", 18) {}

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) return super._update(from, to, value);
        uint256 tax = value / 100;
        super._update(from, address(0), tax);
        super._update(from, to, value - tax);
    }
}

/// @notice A graduation handler that behaves like a pool without needing one: it keeps the
///         liquidity, quotes a constant product for buybacks, and can hand fees back.
contract MockGraduator is IGraduationHandler {
    using SafeERC20 for IERC20;

    IHoodFactory public immutable factory;

    struct Pool {
        uint256 tokenReserve;
        uint256 pairReserve;
        bool exists;
    }

    mapping(address token => Pool) public pools;
    mapping(address token => uint256) public compounded;

    constructor(address factory_) {
        factory = IHoodFactory(factory_);
    }

    receive() external payable {}

    function isGraduated(address token) external view returns (bool) {
        return pools[token].exists;
    }

    function prepare(address, address, uint256, uint256, uint24, int24) external {}

    function graduate(address token, address, uint256 tokenAmount, uint256 pairAmount, uint24, int24) external payable {
        pools[token] = Pool({tokenReserve: tokenAmount, pairReserve: pairAmount, exists: true});
    }

    /// @notice Pretends the position earned `pairAmount` and `tokenAmount` in fees.
    function seedFees(address token, uint256 pairAmount, uint256 tokenAmount) external payable {
        pools[token].pairReserve += 0; // fees are held on top of the reserves
        pendingPair[token] += pairAmount;
        pendingToken[token] += tokenAmount;
    }

    mapping(address => uint256) public pendingPair;
    mapping(address => uint256) public pendingToken;

    function collect(address token) external {
        Launch memory l = factory.getLaunch(token);
        uint256 pairAmount = pendingPair[token];
        uint256 tokenAmount = pendingToken[token];
        pendingPair[token] = 0;
        pendingToken[token] = 0;
        if (tokenAmount != 0) IHoodToken(token).burn(tokenAmount);
        if (pairAmount != 0) {
            PairTransfer.pushAndCall(
                l.pairToken, factory.feeRouter(), pairAmount, abi.encodeCall(IHoodFeeRouter.accrue, (token, pairAmount))
            );
        }
    }

    function compound(address token, uint256 amount) external payable {
        Launch memory l = factory.getLaunch(token);
        if (l.pairToken != address(0)) IERC20(l.pairToken).safeTransferFrom(msg.sender, address(this), amount);
        pools[token].pairReserve += amount;
        compounded[token] += amount;
    }

    function buyback(address token, uint256 amount, uint256 minTokensOut) external payable returns (uint256 burned) {
        Launch memory l = factory.getLaunch(token);
        if (l.pairToken != address(0)) IERC20(l.pairToken).safeTransferFrom(msg.sender, address(this), amount);
        Pool storage p = pools[token];
        // constant product, no fee
        burned = (p.tokenReserve * amount) / (p.pairReserve + amount);
        require(burned >= minTokensOut, "slippage");
        p.pairReserve += amount;
        p.tokenReserve -= burned;
        IHoodToken(token).burn(burned);
    }
}

/// @notice Refuses every incoming native transfer, to prove the paths that must not depend on it.
contract RejectNative {
    receive() external payable {
        revert("no");
    }
}

/// @notice The little the LayerZero endpoint has to answer while an adapter is being constructed.
contract MockLZEndpoint {
    mapping(address oapp => address delegate) public delegates;

    function setDelegate(address delegate) external {
        delegates[msg.sender] = delegate;
    }

    function eid() external pure returns (uint32) {
        return 30416;
    }
}
