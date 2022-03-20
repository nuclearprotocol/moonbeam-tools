// This script is expected to run against a parachain network (using launch.ts script)
//
// Purpose is to find the accounts that have unreserved balances leftover from a staking
// bug.
import chalk from "chalk";
import yargs, { string } from "yargs";
import { table } from "table";
import "@moonbeam-network/api-augment";

import { getAccountIdentities, getApiFor, NETWORK_YARGS_OPTIONS, numberWithCommas } from "..";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    at: {
      type: "number",
      description: "Block number to look into",
    },
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);

  const blockHash = argv.at
    ? await api.rpc.chain.getBlockHash(argv.at)
    : await api.rpc.chain.getBlockHash();
  const apiAt = await api.at(blockHash);

  // Load asycnhronously all data
  const [
    blockHeader,
    accountBalances,
    proxies,
    treasuryProposals,
    mappingWithDeposit,
    candidateInfo,
    delegatorState,
  ] = await Promise.all([
    api.rpc.chain.getHeader(blockHash),
    apiAt.query.system.account.entries(),
    apiAt.query.proxy.proxies.entries(),
    apiAt.query.treasury.proposals.entries(),
    apiAt.query.authorMapping.mappingWithDeposit.entries(),
    apiAt.query.parachainStaking.candidateInfo.entries(),
    apiAt.query.parachainStaking.delegatorState.entries(),
  ]);
  // ACTUAL AMOUNT RESERVED FOR ALL ACCOUNTS
  const reservedAccounts: { [accountId: string]: { accountId: string; reserved: bigint } } =
    accountBalances.reduce((p, v) => {
      const accountId = `0x${v[0].toHex().slice(-40)}`;
      const reserved = v[1].data.reserved.toBigInt();
      if (!p[accountId]) {
        p[accountId] = {
          accountId,
          reserved,
        };
      }
      return p;
    }, {});
  // EXPECTED RESERVED = STAKING (CANDIDATE || DELEGATOR) + AUTHOR MAPPING +
  // PROXY + TREASURY
  const treasuryDeposits: { [accountId: string]: { accountId: string; reserved: bigint } } =
    treasuryProposals.reduce((p, v) => {
      const treasuryProposal = v[1].unwrap();
      const accountId = `0x${treasuryProposal.proposer.toHex().slice(-40)}`;
      const reserved = treasuryProposal.bond.toBigInt();
      if (!p[accountId]) {
        p[accountId] = {
          accountId,
          reserved: 0n,
        };
      }
      p[accountId].reserved += reserved;
      return p;
    }, {});
  const proxyDeposits: { [accountId: string]: { accountId: string; reserved: bigint } } =
    proxies.reduce((p, v) => {
      const reserved = v[1][1].toBigInt();
      const accountId = `0x${v[0].toHex().slice(-40)}`;
      if (!p[accountId]) {
        p[accountId] = {
          accountId,
          reserved: 0n,
        };
      }
      p[accountId].reserved += reserved;
      return p;
    }, {});
  const authorMappingDeposits: { [accountId: string]: { accountId: string; reserved: bigint } } =
    mappingWithDeposit.reduce((p, v) => {
      const registrationInfo = v[1].unwrap();
      const accountId = `0x${registrationInfo.account.toHex().slice(-40)}`;
      const reserved = registrationInfo.deposit;
      if (!p[accountId]) {
        p[accountId] = {
          accountId,
          reserved: 0n,
        };
      }
      p[accountId].reserved += reserved;
      return p;
    }, {});
  const candidateDeposits: { [accountId: string]: { accountId: string; reserved: bigint } } =
    candidateInfo.reduce((p, v) => {
      const candidate = v[1].unwrap();
      const id = `0x${v[0].toHex().slice(-40)}`;
      const reserved = candidate.bond;
      if (!p[id]) {
        p[id] = {
          id,
          reserved: 0n,
        };
      }
      p[id].reserved += reserved;
      return p;
    }, {});
  const delegatorDeposits: { [accountId: string]: { accountId: string; reserved: bigint } } =
    delegatorState.reduce((p, v) => {
      const delegator = v[1].unwrap();
      const id = `0x${v[0].toHex().slice(-40)}`;
      const reserved = delegator.total;
      if (!p[id]) {
        p[id] = {
          id,
          reserved: 0n,
        };
      }
      p[id].reserved += reserved;
      return p;
    }, {});
  var negativeImbalanceRequiresHotfixExtrinsic = false;
  const imbalancesToFix = [];
  const allDeposits: { [accountId: string]: bigint } = [
    ...Object.keys(authorMappingDeposits),
    ...Object.keys(candidateDeposits),
    ...Object.keys(delegatorDeposits),
    ...Object.keys(treasuryDeposits),
    ...Object.keys(proxyDeposits),
    ...Object.keys(reservedAccounts),
  ].reduce((p, accountId) => {
    if (p[accountId]) {
      return p;
    }
    // const deposits = [{}]; and sum them to print if hotfix required
    const expectedReserved: bigint =
      authorMappingDeposits[accountId].reserved +
      candidateDeposits[accountId].reserved +
      delegatorDeposits[accountId].reserved +
      treasuryDeposits[accountId].reserved +
      proxyDeposits[accountId].reserved;
    if (expectedReserved != reservedAccounts[accountId].reserved) {
      console.log("Printing different RESERVED and EXPECTED_RESERVED for ", accountId);
      if (reservedAccounts[accountId].reserved < expectedReserved) {
        negativeImbalanceRequiresHotfixExtrinsic = true;
        console.log(
          "BUG REQUIRES HOTFIX EXTRINSIC TO CORRECT ACCOUNT: ",
          accountId,
          "RESERVED: ",
          reservedAccounts[accountId].reserved,
          "EXPECTED RESERVED: ",
          expectedReserved
        );
      }
      const dueToBeUnreserved = reservedAccounts[accountId].reserved - expectedReserved;
      console.log(
        "RESERVED: ",
        reservedAccounts[accountId].reserved,
        "EXPECTED RESERVED: ",
        expectedReserved,
        "POSITIVE DIFFERENCE: ",
        dueToBeUnreserved
      );
      // COLLECT INTO OUTPUT
      imbalancesToFix.push({ accountId, dueToBeUnreserved });
    }
    p[accountId] = expectedReserved;
    return p;
  }, {});
  console.log("DUE TO BE UNRESERVED: \n", imbalancesToFix);
  if (negativeImbalanceRequiresHotfixExtrinsic) {
    console.log("FIX REQUIRES HOTFIX EXTRINSIC TO FIX NEGATIVE RESERVE IMBALANCE(S)");
    // look for console output prefixed by
    // `BUG REQUIRES HOTFIX EXTRINSIC TO CORRECT ACCOUNT: `
  }
  // TODO: propose and send as democracy proposal
  api.disconnect();
};

main();
