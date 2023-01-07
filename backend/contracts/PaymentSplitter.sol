// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "hardhat/console.sol";

contract PaymentSplitter {
    using SafeERC20 for IERC20;

    uint billCounter;
    mapping(uint => Bill) bills;

    struct Bill {
        address recipient;
        address[] payers;
        address token;
        uint fee;
        uint total;
        uint pledged;
        bool payed;
    }

    event BillCreated(
        uint id,
        address recipient,
        address[] payers,
        address token,
        uint total
    );

    event BillPaymentSubmitted(uint id, address payer);

    event BillPayed(uint id);

    constructor() {}

    modifier validBill(uint id) {
        require(billCounter > 0, "no bills");
        require(id <= billCounter, "bill does not exist");
        _;
    }

    function getBill(
        uint id
    ) external view validBill(id) returns (Bill memory) {
        return bills[id];
    }

    function createBill(
        address recipient,
        uint total,
        address[] calldata payers,
        address token
    ) external {
        uint fee = total / payers.length;
        billCounter++;
        bills[billCounter] = Bill(
            recipient,
            payers,
            token,
            fee,
            total,
            0,
            false
        );
        emit BillCreated(billCounter, recipient, payers, token, total);
    }

    function submitPayment(uint id) external validBill(id) {
        Bill storage bill = bills[id];

        require(!bill.payed, "bill already payed");
        require((bill.pledged + bill.fee) <= bill.total, "bill overfunded");

        IERC20 token = IERC20(bill.token);
        token.safeTransferFrom(msg.sender, address(this), bill.fee);

        bill.pledged += bill.fee;
        emit BillPaymentSubmitted(id, msg.sender);
    }

    function claimBill(uint id) external validBill(id) {
        Bill storage bill = bills[id];

        require(bill.recipient == msg.sender, "only recipient can claim bill");
        require(bill.pledged == bill.total, "bill underfunded");
        require(!bill.payed, "bill already payed");

        IERC20 token = IERC20(bill.token);
        token.safeTransfer(msg.sender, bill.total);

        bill.payed = true;
        emit BillPayed(id);
    }
}
