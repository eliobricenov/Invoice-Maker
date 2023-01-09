// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract PaymentSplitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint billCounter;
    mapping(uint => Bill) bills;

    struct Bill {
        address payable recipient;
        address token;
        uint total;
        uint pledged;
        bool payed;
    }

    event BillCreated(uint id, address recipient, address token, uint total);

    event BillPaymentSubmitted(uint id, address payer, uint amount);

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
        address payable recipient,
        uint total,
        address token
    ) external {
        billCounter++;
        bills[billCounter] = Bill(recipient, token, total, 0, false);
        emit BillCreated(billCounter, recipient, token, total);
    }

    function submitPayment(uint id, uint amount) external validBill(id) {
        Bill storage bill = bills[id];

        require(!bill.payed, "bill already payed");
        require((bill.pledged + amount) <= bill.total, "bill overfunded");

        IERC20 token = IERC20(bill.token);
        token.safeTransferFrom(msg.sender, address(this), amount);

        bill.pledged += amount;
        emit BillPaymentSubmitted(id, msg.sender, amount);
    }

    function submitEthPayment(uint id) external payable validBill(id) {
        Bill storage bill = bills[id];

        require(bill.token == address(0), "bill uses token");
        require(!bill.payed, "bill already payed");
        require((bill.pledged + msg.value) <= bill.total, "bill overfunded");

        bill.pledged += msg.value;
        emit BillPaymentSubmitted(id, msg.sender, msg.value);
    }

    function claimBill(uint id) external validBill(id) nonReentrant {
        Bill storage bill = bills[id];

        require(bill.recipient == msg.sender, "only recipient can claim bill");
        require(bill.pledged == bill.total, "bill underfunded");
        require(!bill.payed, "bill already payed");

        bill.payed = true;

        if (bill.token == address(0)) {
            (bool sent, ) = bill.recipient.call{value: bill.total}("");
            require(sent, "Failed to send Ether");
        } else {
            IERC20 token = IERC20(bill.token);
            token.safeTransfer(msg.sender, bill.total);
        }

        emit BillPayed(id);
    }
}
