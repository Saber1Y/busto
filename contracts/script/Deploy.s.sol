// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {BustoSettlement, IERC20} from "../src/BustoSettlement.sol";

/// @notice Deploys BustoSettlement to the target network.
/// @dev Required environment (never committed):
///      BOT_RPC_URL           RPC endpoint for the target network
///      BUSTO_PAYMENT_TOKEN   pinned ERC-20 payment asset address
///      BUSTO_TOKEN_DECIMALS  its decimals
///      BUSTO_EDGE_WALLET     the Edge wallet that becomes the authorized caller
///      BUSTO_DEPLOYER_KEY    deployer private key (Edge holds the only settlement key,
///                            but deployment needs its own signer here)
contract Deploy is Script {
    function run() external {
        string memory rpc = vm.envString("BOT_RPC_URL");
        address token = vm.envAddress("BUSTO_PAYMENT_TOKEN");
        uint8 decimals = uint8(vm.envUint("BUSTO_TOKEN_DECIMALS"));
        address edge = vm.envAddress("BUSTO_EDGE_WALLET");
        uint256 pk = vm.envUint("BUSTO_DEPLOYER_KEY");

        uint256 chainId = vm.envOr("EXPECTED_CHAIN_ID", uint256(0));
        if (chainId != 0) {
            require(
                block.chainid == chainId,
                "refusing to deploy: connected chainId does not match EXPECTED_CHAIN_ID"
            );
            console.log("chainId verified:", chainId);
        }

        // Deploy from the Edge key when the Edge is also the deployer, so the
        // authorized settlement caller and the deployer stay consistent.
        vm.startBroadcast(pk);
        BustoSettlement settlement = new BustoSettlement(IERC20(token), decimals, edge);
        vm.stopBroadcast();

        console.log("BustoSettlement:", address(settlement));
        console.log("payment token  :", address(settlement.token()));
        console.log("token decimals :", settlement.tokenDecimals());
        console.log("settlement caller:", settlement.settlementCaller());
        console.log("settledInvoiceCount:", settlement.settledInvoiceCount());
        console.log("totalSettledAmount :", settlement.totalSettledAmount());
    }
}