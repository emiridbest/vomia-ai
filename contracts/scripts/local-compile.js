// Standalone compiler used ONLY inside this sandbox, because the sandbox's
// network egress allowlist doesn't include binaries.soliditylang.org (which
// is where `npx hardhat compile` normally fetches solc from). This script
// uses the solc npm package (pure JS/WASM build, fetched from the npm
// registry, which IS allowed) to do the same compilation Hardhat would do,
// and writes output in the same artifact shape Hardhat/ethers expects so
// the real test suite (test/AgentVault.test.ts) can run unmodified.
//
// On a normal machine with normal internet access, none of this is needed —
// `npx hardhat compile` just works. This file exists for CI/sandbox parity
// only; feel free to delete it once you've verified things locally.
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const CONTRACTS_DIR = path.join(__dirname, "..", "contracts");
const NODE_MODULES = path.join(__dirname, "..", "node_modules");
const ARTIFACTS_DIR = path.join(__dirname, "..", "artifacts");

function findSolFiles(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(findSolFiles(full));
    else if (entry.name.endsWith(".sol")) results.push(full);
  }
  return results;
}

const solFiles = findSolFiles(CONTRACTS_DIR);
const sources = {};
for (const file of solFiles) {
  const rel = path.relative(path.join(__dirname, ".."), file);
  sources[rel] = { content: fs.readFileSync(file, "utf8") };
}

function findImports(importPath) {
  try {
    let resolved;
    if (importPath.startsWith("@openzeppelin")) {
      resolved = path.join(NODE_MODULES, importPath);
    } else {
      // relative import from within contracts/
      resolved = path.join(__dirname, "..", importPath);
    }
    return { contents: fs.readFileSync(resolved, "utf8") };
  } catch (e) {
    return { error: "File not found: " + importPath };
  }
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.methodIdentifiers"] },
    },
  },
};

console.log(`Compiling ${solFiles.length} Solidity files with solc ${solc.version()} ...`);
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

let hasError = false;
if (output.errors) {
  for (const err of output.errors) {
    if (err.severity === "error") {
      hasError = true;
      console.error("\nERROR:\n" + err.formattedMessage);
    } else {
      console.warn("\nWARNING:\n" + err.formattedMessage);
    }
  }
}

if (hasError) {
  console.error("\nCompilation failed.");
  process.exit(1);
}

// Write Hardhat-shaped artifacts: artifacts/<relative-source-path>/<ContractName>.json
for (const [sourcePath, contracts] of Object.entries(output.contracts || {})) {
  for (const [contractName, contractOutput] of Object.entries(contracts)) {
    const outDir = path.join(ARTIFACTS_DIR, sourcePath);
    fs.mkdirSync(outDir, { recursive: true });
    const artifact = {
      _format: "hh-sol-artifact-1",
      contractName,
      sourceName: sourcePath,
      abi: contractOutput.abi,
      bytecode: "0x" + contractOutput.evm.bytecode.object,
      deployedBytecode: "0x" + contractOutput.evm.deployedBytecode.object,
      linkReferences: {},
      deployedLinkReferences: {},
    };
    fs.writeFileSync(path.join(outDir, `${contractName}.json`), JSON.stringify(artifact, null, 2));
  }
}

console.log("Compilation succeeded. Artifacts written to artifacts/");
