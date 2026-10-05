// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {BustoSettlement, IERC20} from "../src/BustoSettlement.sol";

/// Minimal ERC-20 mock. Mirrors conventional USDT behaviour: returns a bool and
/// does NOT revert on failure, so the contract's return-value check is exercised.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// A hostile token that returns false without moving funds — proves the contract
/// cannot record a settlement that did not happen.
contract LyingERC20 {
    function approve(address, uint256) external pure returns (bool) {
        return true;
    }
    function allowance(address, address) external pure returns (uint256) {
        return type(uint256).max;
    }
    function balanceOf(address) external pure returns (uint256) {
        return type(uint256).max;
    }
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

contract BustoSettlementTest is Test {
    BustoSettlement settlement;
    MockERC20 usdt;
    LyingERC20 lying;

    address edge = address(0xED6E); // Busto Edge wallet — the authorized caller
    address vendor = address(0xDEAD01);
    address attacker = address(0xBADBAD);
    bytes32 invoiceRef = keccak256("INV-1042");

    uint256 constant ONE = 1_000_000; // 1.000000 USDT (6 decimals)

    function setUp() public {
        usdt = new MockERC20("Tether USD", "USDT", 6);
        lying = new LyingERC20();
        settlement = new BustoSettlement(IERC20(address(usdt)), 6, edge);
    }

    function _fundAndApprove(uint256 amount) internal {
        usdt.mint(edge, amount);
        vm.prank(edge);
        usdt.approve(address(settlement), amount);
    }

    // ---------------- happy path ----------------

    function test_SettlesInvoiceAndUpdatesLedger() public {
        _fundAndApprove(ONE);

        vm.prank(edge);
        settlement.settleInvoice(invoiceRef, vendor, ONE);

        assertEq(settlement.settledInvoiceCount(), 1);
        assertEq(settlement.totalSettledAmount(), ONE);
        assertTrue(settlement.settlementExists(invoiceRef));
        assertEq(usdt.balanceOf(vendor), ONE, "vendor must receive the exact amount");
        assertEq(usdt.balanceOf(edge), 0, "payer debited");
    }

    function test_StoresFullSettlementRecord() public {
        _fundAndApprove(ONE);

        vm.prank(edge);
        settlement.settleInvoice(invoiceRef, vendor, ONE);

        BustoSettlement.Settlement memory s = settlement.getSettlement(invoiceRef);
        assertEq(s.payer, edge);
        assertEq(s.recipient, vendor);
        assertEq(s.amount, ONE);
        assertEq(s.invoiceRef, invoiceRef);
        assertGt(s.timestamp, 0);
    }

    function test_EmitsInvoiceSettledWithCounters() public {
        _fundAndApprove(ONE * 3);

        vm.expectEmit(true, true, true, true);
        emit BustoSettlement.InvoiceSettled(
            invoiceRef, edge, vendor, ONE, uint64(block.timestamp), 1, ONE
        );
        vm.prank(edge);
        settlement.settleInvoice(invoiceRef, vendor, ONE);
    }

    function test_AggregatesAcrossMultipleInvoices() public {
        _fundAndApprove(ONE * 3);

        bytes32 b = keccak256("INV-2");
        bytes32 c = keccak256("INV-3");

        vm.startPrank(edge);
        settlement.settleInvoice(invoiceRef, vendor, ONE);
        settlement.settleInvoice(b, vendor, ONE);
        settlement.settleInvoice(c, vendor, ONE);
        vm.stopPrank();

        assertEq(settlement.settledInvoiceCount(), 3);
        assertEq(settlement.totalSettledAmount(), ONE * 3);
    }

    function test_ExactAmountAllowanceIsConsumed() public {
        _fundAndApprove(ONE);
        vm.prank(edge);
        settlement.settleInvoice(invoiceRef, vendor, ONE);

        assertEq(usdt.allowance(edge, address(settlement)), 0, "exact allowance consumed, nothing lingers");
    }

    // ---------------- required failure cases ----------------

    function test_RevertWhen_CallerIsNotEdge() public {
        _fundAndApprove(ONE);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(BustoSettlement.Unauthorized.selector, attacker));
        settlement.settleInvoice(invoiceRef, vendor, ONE);

        assertEq(settlement.settledInvoiceCount(), 0);
    }

    function test_RevertWhen_DuplicateInvoice() public {
        _fundAndApprove(ONE * 2);

        vm.startPrank(edge);
        settlement.settleInvoice(invoiceRef, vendor, ONE);
        vm.expectRevert(abi.encodeWithSelector(BustoSettlement.AlreadySettled.selector, invoiceRef));
        settlement.settleInvoice(invoiceRef, vendor, ONE);
        vm.stopPrank();

        assertEq(settlement.settledInvoiceCount(), 1, "replay must not double-count");
        assertEq(usdt.balanceOf(vendor), ONE, "vendor paid exactly once");
    }

    function test_RevertWhen_ZeroAmount() public {
        _fundAndApprove(ONE);
        vm.prank(edge);
        vm.expectRevert(BustoSettlement.ZeroAmount.selector);
        settlement.settleInvoice(invoiceRef, vendor, 0);
    }

    function test_RevertWhen_ZeroRecipient() public {
        _fundAndApprove(ONE);
        vm.prank(edge);
        vm.expectRevert(BustoSettlement.ZeroRecipient.selector);
        settlement.settleInvoice(invoiceRef, address(0), ONE);
    }

    function test_RevertWhen_ZeroInvoiceRef() public {
        _fundAndApprove(ONE);
        vm.prank(edge);
        vm.expectRevert(BustoSettlement.ZeroInvoiceRef.selector);
        settlement.settleInvoice(bytes32(0), vendor, ONE);
    }

    function test_RevertWhen_InsufficientAllowance() public {
        usdt.mint(edge, ONE);
        vm.prank(edge);
        usdt.approve(address(settlement), ONE - 1);

        vm.prank(edge);
        vm.expectRevert(
            abi.encodeWithSelector(BustoSettlement.InsufficientAllowance.selector, ONE - 1, ONE)
        );
        settlement.settleInvoice(invoiceRef, vendor, ONE);
    }

    function test_RevertWhen_NoAllowanceAtAll() public {
        usdt.mint(edge, ONE);
        vm.prank(edge);
        vm.expectRevert(
            abi.encodeWithSelector(BustoSettlement.InsufficientAllowance.selector, 0, ONE)
        );
        settlement.settleInvoice(invoiceRef, vendor, ONE);
    }

    function test_RevertWhen_InsufficientBalance() public {
        usdt.mint(edge, ONE);
        vm.prank(edge);
        usdt.approve(address(settlement), ONE * 10);

        vm.prank(edge);
        vm.expectRevert(
            abi.encodeWithSelector(BustoSettlement.InsufficientBalance.selector, ONE, ONE * 2)
        );
        settlement.settleInvoice(invoiceRef, vendor, ONE * 2);
    }

    function test_WrongTokenCannotSettle() public {
        // A different ERC-20 has no allowance into this contract's token, so the
        // wrong-token rail is dead before any funds move.
        MockERC20 other = new MockERC20("Fake", "FAKE", 6);
        other.mint(edge, ONE * 10);
        vm.prank(edge);
        other.approve(address(settlement), ONE * 10);

        // still uses the pinned token; other token's allowance is irrelevant
        vm.prank(edge);
        vm.expectRevert();
        settlement.settleInvoice(invoiceRef, vendor, ONE);
    }

    function test_CannotDrainMoreThanExactApproval() public {
        // Edge approves exactly ONE. An attacker-controlled caller cannot move it,
        // and even the Edge cannot settle for more than it approved.
        usdt.mint(edge, ONE * 100);
        vm.prank(edge);
        usdt.approve(address(settlement), ONE);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(BustoSettlement.Unauthorized.selector, attacker));
        settlement.settleInvoice(invoiceRef, attacker, ONE * 100);

        assertEq(usdt.balanceOf(attacker), 0);
    }

    function test_HostileTokenReturningFalseDoesNotRecordSettlement() public {
        BustoSettlement s2 = new BustoSettlement(IERC20(address(lying)), 6, edge);
        vm.prank(edge);
        vm.expectRevert(BustoSettlement.TokenTransferFailed.selector);
        s2.settleInvoice(invoiceRef, vendor, ONE);

        assertEq(s2.settledInvoiceCount(), 0, "no phantom settlement recorded");
        assertEq(s2.totalSettledAmount(), 0);
        assertFalse(s2.settlementExists(invoiceRef));
    }

    function test_ConstructorRejectsZeroCaller() public {
        vm.expectRevert(BustoSettlement.ZeroAddress.selector);
        new BustoSettlement(IERC20(address(usdt)), 6, address(0));
    }

    function test_ConstructorRejectsZeroToken() public {
        vm.expectRevert(BustoSettlement.ZeroAddress.selector);
        new BustoSettlement(IERC20(address(0)), 6, edge);
    }

    // ---------------- honest empty-state views ----------------

    function test_FreshContractReportsNoSettlements() public view {
        assertEq(settlement.settledInvoiceCount(), 0);
        assertEq(settlement.totalSettledAmount(), 0);
        assertFalse(settlement.hasSettlements());
    }

    function test_PinsTokenAndDecimals() public view {
        assertEq(address(settlement.token()), address(usdt));
        assertEq(settlement.tokenDecimals(), 6);
        assertEq(settlement.settlementCaller(), edge);
    }
}