// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @title BustoSettlement
/// @notice A settlement ledger for Busto invoice payments on BOT Chain.
/// @dev Busto' threat model is: AI proposes, deterministic code verifies, a human
///      approves, the Edge node signs, the chain settles. This contract is the last
///      step only. It deliberately has no notion of an invoice document, a vendor
///      record or an approval — it cannot tell whether a payment is legitimate. All of
///      that is proven off-chain before a settlement intent reaches the Edge signer.
///
///      It does provide one guarantee the Edge cannot: an auditable, append-only,
///      on-chain record of every settlement, with a replay guard keyed on the invoice
///      reference. Busto already blocks duplicate invoices in SQLite; that guard is
///      mirrored here so the invariant holds even if the local database is lost,
///      rolled back, or a second Edge node is operated against the same contract.
///
///      Authorization is a single settlement caller — the Busto Edge wallet. The AI
///      / orchestrator never holds this role, so a compromised model cannot move
///      funds. Busto grants an EXACT-amount allowance per payment and revokes it
///      immediately after, so a compromised Edge call cannot drain an approved
///      balance beyond the single invoice it was authorized for.
contract BustoSettlement {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    struct Settlement {
        bytes32 invoiceRef;
        address payer;
        address recipient;
        uint256 amount;
        uint64 timestamp;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice The only payment token this contract will move.
    IERC20 public immutable token;

    /// @notice Token decimals, cached so the UI can format amounts without a call.
    uint8 public immutable tokenDecimals;

    /// @notice The Busto Edge wallet. The only address allowed to settle.
    address public immutable settlementCaller;

    /// @notice Number of invoices settled through this contract.
    uint256 public settledInvoiceCount;

    /// @notice Sum of all settled amounts, in token minor units.
    uint256 public totalSettledAmount;

    /// @notice Replay guard. A settled invoiceRef can never be settled again.
    mapping(bytes32 => bool) public settlementExists;

    /// @notice Full settlement record per invoiceRef.
    mapping(bytes32 => Settlement) public settlement;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice Emitted once per settled invoice. Contains enough to rebuild
    ///         settlement history without parsing transaction calldata.
    event InvoiceSettled(
        bytes32 indexed invoiceRef,
        address indexed payer,
        address indexed recipient,
        uint256 amount,
        uint64 timestamp,
        uint256 settledCount,
        uint256 totalVolume
    );

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error ZeroRecipient();
    error ZeroInvoiceRef();
    error AlreadySettled(bytes32 invoiceRef);
    error Unauthorized(address caller);
    error TokenTransferFailed();
    error InsufficientAllowance(uint256 allowed, uint256 required);
    error InsufficientBalance(uint256 balance, uint256 required);

    constructor(IERC20 token_, uint8 tokenDecimals_, address settlementCaller_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        if (settlementCaller_ == address(0)) revert ZeroAddress();
        token = token_;
        tokenDecimals = tokenDecimals_;
        settlementCaller = settlementCaller_;
    }

    /// @notice Settles one verified Busto invoice to its ERP-confirmed vendor wallet.
    /// @dev Caller must be the Busto Edge wallet. Requires an exact-amount token
    ///      allowance for this contract; Busto approves precisely `amount` before
    ///      calling and revokes it after, so an unused allowance does not linger.
    ///
    ///      `invoiceRef` is Busto' invoice reference hashed to bytes32 by the Edge
    ///      node. The Edge derives it deterministically from the invoice reference so
    ///      the same invoice maps to the same replay-guard key on every run.
    ///
    ///      Checks-effects-interactions: state is written before the token call, so a
    ///      hostile/non-standard token cannot re-enter and settle a second invoice.
    ///      For USDT (a conventional, non-fee-on-transfer ERC-20) `amount` is exactly
    ///      what the vendor receives; the contract deliberately does not support
    ///      fee-on-transfer tokens, which would make the recorded amount a lie.
    function settleInvoice(
        bytes32 invoiceRef,
        address recipient,
        uint256 amount
    ) external returns (bool) {
        if (msg.sender != settlementCaller) revert Unauthorized(msg.sender);
        if (invoiceRef == bytes32(0)) revert ZeroInvoiceRef();
        if (recipient == address(0)) revert ZeroRecipient();
        if (amount == 0) revert ZeroAmount();
        if (settlementExists[invoiceRef]) revert AlreadySettled(invoiceRef);

        uint256 allowed = token.allowance(msg.sender, address(this));
        if (allowed < amount) revert InsufficientAllowance(allowed, amount);

        uint256 balance = token.balanceOf(msg.sender);
        if (balance < amount) revert InsufficientBalance(balance, amount);

        // --- effects ---
        settlementExists[invoiceRef] = true;
        settledInvoiceCount += 1;
        totalSettledAmount += amount;
        settlement[invoiceRef] = Settlement({
            invoiceRef: invoiceRef,
            payer: msg.sender,
            recipient: recipient,
            amount: amount,
            timestamp: uint64(block.timestamp)
        });

        // --- interaction ---
        // Checked: a token that returns false must not be able to record a
        // settlement that never moved value.
        if (!token.transferFrom(msg.sender, recipient, amount)) revert TokenTransferFailed();

        emit InvoiceSettled(
            invoiceRef,
            msg.sender,
            recipient,
            amount,
            uint64(block.timestamp),
            settledInvoiceCount,
            totalSettledAmount
        );

        return true;
    }

    /// @notice Returns the full settlement record for an invoice reference.
    function getSettlement(bytes32 invoiceRef) external view returns (Settlement memory) {
        return settlement[invoiceRef];
    }

    /// @notice Convenience view for the console: the contract has settled nothing yet.
    function hasSettlements() external view returns (bool) {
        return settledInvoiceCount != 0;
    }
}