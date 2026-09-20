// The batch file hood.fam hands to Safe{Wallet}'s Transaction Builder must carry the checksum the
// Transaction Builder itself computes, or the file opens with a "this batch was modified" warning
// in front of the signers. This pins our reimplementation to the upstream test vector
// (safe-react-apps, apps/tx-builder/src/lib/checksum.test.js) and round-trips a file of our own.
import { keccak256, stringToBytes } from "viem";
import { batchFileChecksum, safeBatchFile, serializeForChecksum } from "../../packages/sdk/dist/safe.js";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
};

// Upstream vector: addChecksum over a file whose meta already has `checksum: ''`, name nulled.
const upstream = {
  version: "1.0", chainId: "4", createdAt: 1646321521061,
  meta: { name: "test batch file", txBuilderVersion: "1.4.0", checksum: "", createdFromSafeAddress: "0xDF8a1Ce35c9a6ACE153B4e0767942f1E2291a1Aa", createdFromOwnerAddress: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6" },
  transactions: [
    { to: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6", value: "0", contractMethod: { inputs: [{ internalType: "address", name: "paramAddress", type: "address" }], name: "testAddress", payable: false }, contractInputsValues: { paramAddress: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6" } },
    { to: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6", value: "0", contractMethod: { inputs: [{ internalType: "bool", name: "paramBool", type: "bool" }], name: "testBool", payable: false }, contractInputsValues: { paramAddress: "", paramBool: "false" } },
    { to: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6", value: "2000000000000000000", data: "0x42f4579000000000000000000000000049d4450977e2c95362c13d3a31a09311e0ea26a6" },
  ],
};
const got = keccak256(stringToBytes(serializeForChecksum({ ...upstream, meta: { ...upstream.meta, name: null } })));
check("serializer matches the upstream Transaction Builder vector", got === "0x4ecbfd364aa6759983915644e73f8bd411e85a2dc306f252a387c2728c4db64c", got);

// Our own file, validated the way the Transaction Builder validates on import: drop the checksum
// key, recompute, compare.
const file = safeBatchFile({
  safe: "0x000000000000000000000000000000000000dEaD", chainId: 4663, name: "hood.fam accept ownership",
  calls: [{ to: "0x1111111111111111111111111111111111111111", data: "0x79ba5097" }, { to: "0x2222222222222222222222222222222222222222", value: 5n, data: "0x" }],
});
const { checksum, ...metaWithout } = file.meta;
const recomputed = keccak256(stringToBytes(serializeForChecksum({ ...file, meta: { ...metaWithout, name: null } })));
check("a file we write validates on import", checksum === recomputed, checksum);
check("the checksum ignores the batch name", batchFileChecksum({ ...file, meta: { ...file.meta, name: "renamed" } }) === checksum);
check("values are decimal strings", file.transactions[1].value === "5" && file.transactions[0].value === "0");
check("the chain is 4663", file.chainId === "4663");

if (failed) process.exit(1);
