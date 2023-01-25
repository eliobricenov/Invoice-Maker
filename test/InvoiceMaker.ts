import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { ERC20, InvoiceMaker } from "../typechain-types";
const { utils } = ethers;

const payersQuantity = 4;
const invoiceTotal = utils.parseEther(String(payersQuantity * 0.1));
const payersInitialBalance = utils.parseEther("1000");
const paymentAmount = utils.parseEther("0.1");

function getRevertedMessage(message: string) {
  return `VM Exception while processing transaction: reverted with reason string '${message}'`;
}

describe("InvoiceMaker", () => {
  async function deployFixture() {
    const Token = await ethers.getContractFactory("MockToken");
    const Splitter = await ethers.getContractFactory("InvoiceMaker");
    const token = await Token.deploy();
    const splitter = await Splitter.deploy();
    const signers = await ethers.getSigners();
    const payers = [signers[0]];

    for (let index = 1; index < payersQuantity; index++) {
      const payer = signers[index];
      payers.push(payer);
      await token.transfer(payer.address, payersInitialBalance);
    }

    return {
      token,
      splitter,
      payers,
      recipient: signers[payersQuantity + 1],
    };
  }

  async function createInvoiceFixture(
    options: { useEth: boolean } = { useEth: false }
  ) {
    const deployFixtureParams = await deployFixture();
    const { useEth } = options;
    const { token, splitter, recipient } = deployFixtureParams;

    await splitter.createInvoice(
      recipient.address,
      invoiceTotal,
      useEth ? ethers.constants.AddressZero : token.address
    );

    const invoice = await splitter.getInvoice(1);
    return { invoice, ...deployFixtureParams };
  }

  async function submitPayment({
    invoiceId,
    payer,
    token,
    splitter,
  }: {
    invoiceId: number;
    token: ERC20;
    splitter: InvoiceMaker;
    payer: SignerWithAddress;
  }) {
    await token
      .connect(payer)
      .increaseAllowance(splitter.address, ethers.constants.MaxUint256);
    await splitter.connect(payer).submitPayment(invoiceId, paymentAmount);
  }

  describe("Get invoice", () => {
    it("Validates empty invoices", async () => {
      const { splitter } = await deployFixture();
      return await expect(splitter.getInvoice(1)).to.be.rejected;
    });

    it("Validates invoice id provided", async () => {
      const { splitter } = await createInvoiceFixture();
      return await expect(splitter.getInvoice(2)).to.be.rejected;
    });

    it("Can get invoice with valid id", async () => {
      const { splitter } = await createInvoiceFixture();
      await splitter.getInvoice(1);
    });
  });

  describe("Create invoice", () => {
    it("Can create a invoice", async () => {
      const { token, recipient, invoice } = await createInvoiceFixture();
      expect(invoice.recipient).to.equal(recipient.address);
      expect(invoice.total).to.equal(invoiceTotal.toString());
      expect(invoice.token).to.equal(token.address);
      expect(invoice.pledgedAmount).to.equal("0");
      expect(invoice.claimed).to.equal(false);
    });
  });

  describe("Submit token payment", () => {
    it("Validates empty invoices", async () => {
      const { splitter } = await deployFixture();
      return await expect(splitter.submitPayment(1, paymentAmount)).to.be
        .rejected;
    });

    it("Validates invoice id provided", async () => {
      const { splitter } = await createInvoiceFixture();
      return await expect(splitter.submitPayment(2, paymentAmount)).to.be
        .rejected;
    });

    it("Can submit payment", async () => {
      const invoiceId = 1;
      const { splitter, token, payers } = await createInvoiceFixture();
      const payer = payers[0];

      const payerBalanceBeforePayment = await token.balanceOf(payer.address);

      await submitPayment({ invoiceId, splitter, token, payer });

      const invoice = await splitter.getInvoice(invoiceId);
      const payerBalanceAfterPayment = await token.balanceOf(payer.address);

      expect(payerBalanceAfterPayment.toString()).to.equal(
        payerBalanceBeforePayment.sub(paymentAmount).toString()
      );

      expect(invoice.pledgedAmount.toString()).to.equal(
        paymentAmount.toString()
      );
    });

    it("Validates over-payment", async () => {
      const invoiceId = 1;
      const { splitter, token, payers } = await createInvoiceFixture();

      for await (const payer of payers) {
        await submitPayment({ payer, invoiceId, splitter, token });
      }

      return await expect(
        splitter.connect(payers[0]).submitPayment(invoiceId, paymentAmount)
      ).to.be.rejectedWith(getRevertedMessage("invoice overfunded"));
    });

    it("Validates no submit after invoice is claimed", async () => {
      const invoiceId = 1;
      const { splitter, token, payers, recipient, invoice } =
        await createInvoiceFixture();

      for await (const payer of payers) {
        await submitPayment({ payer, invoiceId, splitter, token });
      }

      await splitter.connect(recipient).claimInvoice(1);

      return await expect(
        splitter.submitPayment(1, invoice.total.div(payers.length))
      ).to.be.rejectedWith(getRevertedMessage("invoice already claimed"));
    });
  });

  describe("Submit Ether payment", () => {
    it("Validates empty invoices", async () => {
      const { splitter } = await deployFixture();
      return await expect(
        splitter.submitEthPayment(1, {
          value: paymentAmount,
        })
      ).to.be.rejected;
    });

    it("Validates invoice id provided", async () => {
      const { splitter } = await createInvoiceFixture({ useEth: true });
      return await expect(
        splitter.submitEthPayment(2, {
          value: paymentAmount,
        })
      ).to.be.rejected;
    });

    it("Validates invoice does not use token", async () => {
      const { splitter } = await createInvoiceFixture();
      return await expect(
        splitter.submitEthPayment(1, {
          value: paymentAmount,
        })
      ).to.be.rejectedWith(getRevertedMessage("invoice uses token"));
    });

    it("Can submit payment", async () => {
      const invoiceId = 1;

      const { splitter, payers } = await createInvoiceFixture({
        useEth: true,
      });

      const payer = payers[0];

      const payerBalanceBeforePayment = await ethers.provider.getBalance(
        payer.address
      );

      const paymentTx = await splitter.submitEthPayment(invoiceId, {
        value: paymentAmount,
      });

      const receipt = await paymentTx.wait();

      const gasUsed = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice);

      const invoice = await splitter.getInvoice(invoiceId);

      const payerBalanceAfterPayment = await ethers.provider.getBalance(
        payer.address
      );

      expect(payerBalanceAfterPayment.toString()).to.equal(
        payerBalanceBeforePayment.sub(paymentAmount).sub(gasUsed).toString()
      );

      expect(invoice.pledgedAmount.toString()).to.equal(
        paymentAmount.toString()
      );
    });

    it("Validates over-payment", async () => {
      const invoiceId = 1;
      const { splitter, payers } = await createInvoiceFixture({ useEth: true });

      for await (const payer of payers) {
        await splitter.connect(payer).submitEthPayment(invoiceId, {
          value: paymentAmount,
        });
      }

      return await expect(
        splitter.connect(payers[0]).submitEthPayment(invoiceId, {
          value: paymentAmount,
        })
      ).to.be.rejectedWith(getRevertedMessage("invoice overfunded"));
    });

    it("Validates no submit after invoice is claimed", async () => {
      const invoiceId = 1;
      const { splitter, payers, recipient } = await createInvoiceFixture({
        useEth: true,
      });

      for await (const payer of payers) {
        await splitter.connect(payer).submitEthPayment(invoiceId, {
          value: paymentAmount,
        });
      }

      await splitter.connect(recipient).claimInvoice(invoiceId);

      return await expect(
        splitter.connect(payers[0]).submitEthPayment(invoiceId, {
          value: paymentAmount,
        })
      ).to.be.rejectedWith(getRevertedMessage("invoice already claimed"));
    });
  });
  describe("Claim invoice", () => {
    it("Validates empty invoices", async () => {
      const { splitter } = await deployFixture();
      return await expect(splitter.claimInvoice(1)).to.be.rejected;
    });

    it("Validates invoice id provided", async () => {
      const { splitter } = await createInvoiceFixture();
      return await expect(splitter.claimInvoice(2)).to.be.rejected;
    });

    it("Validates that only the recipient can claim the invoice", async () => {
      const { splitter, token, payers } = await createInvoiceFixture();
      return await expect(splitter.claimInvoice(1)).to.be.rejectedWith(
        getRevertedMessage("only recipient can claim invoice")
      );
    });

    it("Validates that payment has to be complete before claim", async () => {
      const { splitter, recipient } = await createInvoiceFixture();
      return await expect(
        splitter.connect(recipient).claimInvoice(1)
      ).to.be.rejectedWith(getRevertedMessage("invoice underfunded"));
    });

    it("Can claim token invoice", async () => {
      const invoiceId = 1;
      const { splitter, token, payers, recipient } =
        await createInvoiceFixture();

      const recipientBalanceBeforeClaim = await token.balanceOf(
        recipient.address
      );

      for await (const payer of payers) {
        await submitPayment({ payer, invoiceId, splitter, token });
      }

      await splitter.connect(recipient).claimInvoice(1);

      const recipientBalanceAfterClaim = await token.balanceOf(
        recipient.address
      );

      const invoice = await splitter.getInvoice(1);

      expect(invoice.claimed).to.equal(true);

      expect(recipientBalanceAfterClaim.toString()).to.equal(
        recipientBalanceBeforeClaim.add(invoice.total).toString()
      );
    });

    it("Can claim Ether invoice", async () => {
      const invoiceId = 1;
      const { splitter, token, payers, recipient } = await createInvoiceFixture(
        {
          useEth: true,
        }
      );

      const recipientBalanceBeforeClaim = await ethers.provider.getBalance(
        recipient.address
      );

      for await (const payer of payers) {
        await splitter.connect(payer).submitEthPayment(invoiceId, {
          value: paymentAmount,
        });
      }

      const claimTx = await splitter.connect(recipient).claimInvoice(1);

      const receipt = await claimTx.wait();

      const gasUsed = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice);

      const recipientBalanceAfterClaim = await ethers.provider.getBalance(
        recipient.address
      );

      const invoice = await splitter.getInvoice(1);

      expect(invoice.claimed).to.equal(true);

      expect(recipientBalanceAfterClaim.toString()).to.equal(
        recipientBalanceBeforeClaim.add(invoice.total).sub(gasUsed).toString()
      );
    });

    it("Validates invoice cannot be re-claimed", async () => {
      const invoiceId = 1;
      const { splitter, token, payers, recipient, invoice } =
        await createInvoiceFixture();

      for await (const payer of payers) {
        await submitPayment({ payer, invoiceId, splitter, token });
      }

      await splitter.connect(recipient).claimInvoice(1);

      return await expect(
        splitter.connect(recipient).claimInvoice(1)
      ).to.be.rejectedWith(getRevertedMessage("invoice already claimed"));
    });
  });
});
