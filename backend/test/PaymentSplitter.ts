import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { ERC20, PaymentSplitter } from "../typechain-types";
const { utils } = ethers;

const payersQuantity = 4;
const billTotal = utils.parseEther(String(payersQuantity * 1000));
const payersInitialBalance = utils.parseEther(String(1_000));

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

  async function createBillFixture() {
    const deployFixtureParams = await deployFixture();
    const { token, splitter, recipient, payers } = deployFixtureParams;

    await splitter.createBill(
      recipient.address,
      billTotal,
      payers.map((p) => p.address),
      token.address
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
    await splitter.connect(payer).submitPayment(billId);
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
      const { token, recipient, payers, bill } = await createBillFixture();
      expect(bill.recipient).to.equal(recipient.address);
      expect(bill.total).to.equal(billTotal.toString());
      expect(bill.fee).to.equal(
        billTotal.div(String(payers.length)).toString()
      );
      expect(bill.payers.join(",")).to.equal(
        payers.map((p) => p.address).join(",")
      );
      expect(bill.token).to.equal(token.address);
      expect(bill.pledged).to.equal("0");
      expect(bill.payed).to.equal(false);
    });
  });

  describe("Submit payment", () => {
    it("Validates empty bills", async () => {
      const { splitter } = await deployFixture();
      return await expect(splitter.submitPayment(1)).to.be.rejected;
    });

    it("Validates bill id provided", async () => {
      const { splitter } = await createBillFixture();
      return await expect(splitter.submitPayment(2)).to.be.rejected;
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
        payerBalanceBeforePayment.sub(bill.fee).toString()
      );

      expect(bill.pledged.toString()).to.equal(bill.fee.toString());
    });

    it("Validates over-payment", async () => {
      const billId = 1;
      const { splitter, token, payers } = await createBillFixture();

      for await (const payer of payers) {
        await submitPayment({ payer, billId, splitter, token });
      }

      return await expect(
        splitter.connect(payers[0]).submitPayment(billId)
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

      return await expect(splitter.submitPayment(1)).to.be.rejectedWith(
        getRevertedMessage("bill already payed")
      );
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

    it("Can claim bill", async () => {
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
