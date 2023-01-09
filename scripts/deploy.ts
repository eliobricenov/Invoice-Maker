import { ethers } from "hardhat";

async function main() {
  const Splitter = await ethers.getContractFactory("PaymentSplitter");
  const deployTx = await Splitter.deploy();
  console.log(`Deployed contract: ${deployTx.address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
