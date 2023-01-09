// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract InvoiceMaker is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint invoiceCounter;
    mapping(uint => Invoice) invoices;

    struct Invoice {
        address payable recipient;
        address token;
        uint total;
        uint pledged;
        bool payed;
    }

    event InvoiceCreated(uint id, address recipient, address token, uint total);

    event InvoicePaymentSubmitted(uint id, address payer, uint amount);

    event InvoicePayed(uint id);

    constructor() {}

    modifier validInvoice(uint id) {
        require(invoiceCounter > 0, "no invoices");
        require(id <= invoiceCounter, "invoice does not exist");
        _;
    }

    function getInvoice(
        uint id
    ) external view validInvoice(id) returns (Invoice memory) {
        return invoices[id];
    }

    function createInvoice(
        address payable recipient,
        uint total,
        address token
    ) external {
        invoiceCounter++;
        invoices[invoiceCounter] = Invoice(recipient, token, total, 0, false);
        emit InvoiceCreated(invoiceCounter, recipient, token, total);
    }

    function submitPayment(uint id, uint amount) external validInvoice(id) {
        Invoice storage invoice = invoices[id];

        require(!invoice.payed, "invoice already payed");
        require(
            (invoice.pledged + amount) <= invoice.total,
            "invoice overfunded"
        );

        IERC20 token = IERC20(invoice.token);
        token.safeTransferFrom(msg.sender, address(this), amount);

        invoice.pledged += amount;
        emit InvoicePaymentSubmitted(id, msg.sender, amount);
    }

    function submitEthPayment(uint id) external payable validInvoice(id) {
        Invoice storage invoice = invoices[id];

        require(invoice.token == address(0), "invoice uses token");
        require(!invoice.payed, "invoice already payed");
        require(
            (invoice.pledged + msg.value) <= invoice.total,
            "invoice overfunded"
        );

        invoice.pledged += msg.value;
        emit InvoicePaymentSubmitted(id, msg.sender, msg.value);
    }

    function claimInvoice(uint id) external validInvoice(id) nonReentrant {
        Invoice storage invoice = invoices[id];

        require(
            invoice.recipient == msg.sender,
            "only recipient can claim invoice"
        );
        require(invoice.pledged == invoice.total, "invoice underfunded");
        require(!invoice.payed, "invoice already payed");

        invoice.payed = true;

        if (invoice.token == address(0)) {
            (bool sent, ) = invoice.recipient.call{value: invoice.total}("");
            require(sent, "Failed to send Ether");
        } else {
            IERC20 token = IERC20(invoice.token);
            token.safeTransfer(msg.sender, invoice.total);
        }

        emit InvoicePayed(id);
    }
}
