import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { ERC20, PaymentSplitter } from "../typechain-types";
const { utils } = ethers;

const payersQuantity = 4;
const billTotal = utils.parseEther(String(payersQuantity * 0.1));
const payersInitialBalance = utils.parseEther("1000");
const paymentAmount = utils.parseEther("0.1");

function getRevertedMessage(message: string) {
  return `VM Exception while processing transaction: reverted with reason string '${message}'`;
}

describe("PaymentSplitter", () => {
  async function deployFixture() {
    const Token = await ethers.getContractFactory("MockToken");
    const Splitter = await ethers.getContractFactory("PaymentSplitter");
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

  async function createBillFixture(
    options: { useEth: boolean } = { useEth: false }
  ) {
    const deployFixtureParams = await deployFixture();
    const { useEth } = options;
    const { token, splitter, recipient } = deployFixtureParams;

    await splitter.createBill(
      recipient.address,
      billTotal,
      useEth ? ethers.constants.AddressZero : token.address
    );

    const bill = await splitter.getBill(1);
    return { bill, ...deployFixtureParams };
  }

  async function submitPayment({
    billId,
    payer,
    token,
    splitter,
  }: {
    billId: number;
    token: ERC20;
    splitter: PaymentSplitter;
    payer: SignerWithAddress;
  }) {
    await token
      .connect(payer)
      .increaseAllowance(splitter.address, ethers.constants.MaxUint256);
    await splitter.connect(payer).submitPayment(billId, paymentAmount);
  }

  describe("Get bill", () => {
    it("Validates empty bills", async () => {
      const { splitter } = await deployFixture();
      return await expect(splitter.getBill(1)).to.be.rejected;
    });

    it("Validates bill id provided", async () => {
      const { splitter } = await createBillFixture();
      return await expect(splitter.getBill(2)).to.be.rejected;
    });

    it("Can get bill with valid id", async () => {
      const { splitter } = await createBillFixture();
      await splitter.getBill(1);
    });
  });

  describe("Create bill", () => {
    it("Can create a bill", async () => {
      const { token, recipient, bill } = await createBillFixture();
      expect(bill.recipient).to.equal(recipient.address);
      expect(bill.total).to.equal(billTotal.toString());
      expect(bill.token).to.equal(token.address);
      expect(bill.pledged).to.equal("0");
      expect(bill.payed).to.equal(false);
    });
  });

  describe("Submit token payment", () => {
    it("Validates empty bills", async () => {
      const { splitter } = await deployFixture();
      return await expect(splitter.submitPayment(1, paymentAmount)).to.be
        .rejected;
    });

    it("Validates bill id provided", async () => {
      const { splitter } = await createBillFixture();
      return await expect(splitter.submitPayment(2, paymentAmount)).to.be
        .rejected;
    });

    it("Can submit payment", async () => {
      const billId = 1;
      const { splitter, token, payers } = await createBillFixture();
      const payer = payers[0];

      const payerBalanceBeforePayment = await token.balanceOf(payer.address);

      await submitPayment({ billId, splitter, token, payer });

      const bill = await splitter.getBill(billId);
      const payerBalanceAfterPayment = await token.balanceOf(payer.address);

      expect(payerBalanceAfterPayment.toString()).to.equal(
        payerBalanceBeforePayment.sub(paymentAmount).toString()
      );

      expect(bill.pledged.toString()).to.equal(paymentAmount.toString());
    });

    it("Validates over-payment", async () => {
      const billId = 1;
      const { splitter, token, payers } = await createBillFixture();

      for await (const payer of payers) {
        await submitPayment({ payer, billId, splitter, token });
      }

      return await expect(
        splitter.connect(payers[0]).submitPayment(billId, paymentAmount)
      ).to.be.rejectedWith(getRevertedMessage("bill overfunded"));
    });

    it("Validates no submit after bill is claimed", async () => {
      const billId = 1;
      const { splitter, token, payers, recipient, bill } =
        await createBillFixture();

      for await (const payer of payers) {
        await submitPayment({ payer, billId, splitter, token });
      }

      await splitter.connect(recipient).claimBill(1);

      return await expect(
        splitter.submitPayment(1, bill.total.div(payers.length))
      ).to.be.rejectedWith(getRevertedMessage("bill already payed"));
    });
  });

  describe("Submit Ether payment", () => {
    it("Validates empty bills", async () => {
      const { splitter } = await deployFixture();
      return await expect(
        splitter.submitEthPayment(1, {
          value: paymentAmount,
        })
      ).to.be.rejected;
    });

    it("Validates bill id provided", async () => {
      const { splitter } = await createBillFixture({ useEth: true });
      return await expect(
        splitter.submitEthPayment(2, {
          value: paymentAmount,
        })
      ).to.be.rejected;
    });

    it("Validates bill does not use token", async () => {
      const { splitter } = await createBillFixture();
      return await expect(
        splitter.submitEthPayment(1, {
          value: paymentAmount,
        })
      ).to.be.rejectedWith(getRevertedMessage("bill uses token"));
    });

    it("Can submit payment", async () => {
      const billId = 1;

      const { splitter, payers } = await createBillFixture({
        useEth: true,
      });

      const payer = payers[0];

      const payerBalanceBeforePayment = await ethers.provider.getBalance(
        payer.address
      );

      const paymentTx = await splitter.submitEthPayment(billId, {
        value: paymentAmount,
      });

      const receipt = await paymentTx.wait();

      const gasUsed = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice);

      const bill = await splitter.getBill(billId);

      const payerBalanceAfterPayment = await ethers.provider.getBalance(
        payer.address
      );

      expect(payerBalanceAfterPayment.toString()).to.equal(
        payerBalanceBeforePayment.sub(paymentAmount).sub(gasUsed).toString()
      );

      expect(bill.pledged.toString()).to.equal(paymentAmount.toString());
    });

    it("Validates over-payment", async () => {
      const billId = 1;
      const { splitter, payers } = await createBillFixture({ useEth: true });

      for await (const payer of payers) {
        await splitter.connect(payer).submitEthPayment(billId, {
          value: paymentAmount,
        });
      }

      return await expect(
        splitter.connect(payers[0]).submitEthPayment(billId, {
          value: paymentAmount,
        })
      ).to.be.rejectedWith(getRevertedMessage("bill overfunded"));
    });

    it("Validates no submit after bill is claimed", async () => {
      const billId = 1;
      const { splitter, payers, recipient } = await createBillFixture({
        useEth: true,
      });

      for await (const payer of payers) {
        await splitter.connect(payer).submitEthPayment(billId, {
          value: paymentAmount,
        });
      }

      await splitter.connect(recipient).claimBill(billId);

      return await expect(
        splitter.connect(payers[0]).submitEthPayment(billId, {
          value: paymentAmount,
        })
      ).to.be.rejectedWith(getRevertedMessage("bill already payed"));
    });
  });
  describe("Claim bill", () => {
    it("Validates empty bills", async () => {
      const { splitter } = await deployFixture();
      return await expect(splitter.claimBill(1)).to.be.rejected;
    });

    it("Validates bill id provided", async () => {
      const { splitter } = await createBillFixture();
      return await expect(splitter.claimBill(2)).to.be.rejected;
    });

    it("Validates that only the recipient can claim the bill", async () => {
      const { splitter, token, payers } = await createBillFixture();
      return await expect(splitter.claimBill(1)).to.be.rejectedWith(
        getRevertedMessage("only recipient can claim bill")
      );
    });

    it("Validates that payment has to be complete before claim", async () => {
      const { splitter, recipient } = await createBillFixture();
      return await expect(
        splitter.connect(recipient).claimBill(1)
      ).to.be.rejectedWith(getRevertedMessage("bill underfunded"));
    });

    it("Can claim token bill", async () => {
      const billId = 1;
      const { splitter, token, payers, recipient } = await createBillFixture();

      const recipientBalanceBeforeClaim = await token.balanceOf(
        recipient.address
      );

      for await (const payer of payers) {
        await submitPayment({ payer, billId, splitter, token });
      }

      await splitter.connect(recipient).claimBill(1);

      const recipientBalanceAfterClaim = await token.balanceOf(
        recipient.address
      );

      const bill = await splitter.getBill(1);

      expect(bill.payed).to.equal(true);

      expect(recipientBalanceAfterClaim.toString()).to.equal(
        recipientBalanceBeforeClaim.add(bill.total).toString()
      );
    });

    it("Can claim Ether bill", async () => {
      const billId = 1;
      const { splitter, token, payers, recipient } = await createBillFixture({
        useEth: true,
      });

      const recipientBalanceBeforeClaim = await ethers.provider.getBalance(
        recipient.address
      );

      for await (const payer of payers) {
        await splitter.connect(payer).submitEthPayment(billId, {
          value: paymentAmount,
        });
      }

      const claimTx = await splitter.connect(recipient).claimBill(1);

      const receipt = await claimTx.wait();

      const gasUsed = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice);

      const recipientBalanceAfterClaim = await ethers.provider.getBalance(
        recipient.address
      );

      const bill = await splitter.getBill(1);

      expect(bill.payed).to.equal(true);

      expect(recipientBalanceAfterClaim.toString()).to.equal(
        recipientBalanceBeforeClaim.add(bill.total).sub(gasUsed).toString()
      );
    });

    it("Validates bill cannot be re-claimed", async () => {
      const billId = 1;
      const { splitter, token, payers, recipient, bill } =
        await createBillFixture();

      for await (const payer of payers) {
        await submitPayment({ payer, billId, splitter, token });
      }

      await splitter.connect(recipient).claimBill(1);

      return await expect(
        splitter.connect(recipient).claimBill(1)
      ).to.be.rejectedWith(getRevertedMessage("bill already payed"));
    });
  });
});
