# wallet-analysist

This repo contains a single script (`analyze-address.js`) that generates a **Part 1 + Part 2** assessment for a Solana address.

It was built to be simple enough to hand to someone who is not strong at coding:

- It runs as a CLI command.
- It outputs:
  - a short console summary
  - a machine-readable `report.json` (easy to share and copy/paste into a write-up)

The current implementation supports **Part 2** (SOL/WSOL-only heuristics; no external token pricing).

## Quick start

### 1) Install

```bash
yarn install
# or: npm install
```

### 2) Run

```bash
node analyze-address.js \
  --address <BASE58_ADDRESS> \
  --days 2 \
  --maxTx 500 \
  --concurrency 3 \
  --minDelayMs 150 \
  --out report.json
```

Optional flags:

- `--rpc <url>`: use a specific RPC (recommended for reliability)
- `--verbose`: progress output while fetching transactions

### 3) Output

- **Console**: a short human-readable summary.
- **JSON file**: `report.json` containing structured data for Part 1 and Part 2.

## Parameters (what they mean)

- `--address` (required)
  - Solana address to analyze.

- `--days`
  - Lookback window in days.
  - The script stops fetching signatures once it hits transactions older than `now - days`.

- `--maxTx`
  - Maximum number of transactions (signatures) to fetch within the lookback.
  - If an address has more activity than `maxTx`, your report is a **sample** capped at this limit.

- `--concurrency`
  - How many `getTransaction` calls happen in parallel.
  - Increase for speed, decrease if you hit rate limits.

- `--minDelayMs`
  - Minimum delay inserted between RPC calls (simple throttling).

- `--maxRetries` and `--baseRetryDelayMs`
  - Exponential backoff retry behavior for RPC 429 rate limits.

- `--rpc` / `SOLANA_RPC_URL`
  - RPC endpoint override.

## How the script satisfies the assessment requirements

Your original requirements:

- Part 1 — Address Analysis
- Part 2 — Opportunity Assessment

The script maps to these sections in `report.json`.

### Part 1 — Address Analysis mapping

The script produces these top-level sections:

- `classification`
- `activity`
- `users`
- `protocols`
- `balances`
- `control`

These correspond to Part 1 prompts:

- **What this address is (wallet, program, token, etc.)**
  - `classification.type` and the supporting fields:
    - `classification.executable`
    - `classification.owner`
    - `classification.dataLength`

- **What it does (transaction patterns + DEX interactions)**
  - `protocols.topPrograms` and `protocols.counts`
  - DEX/protocol touches are detected by matching program IDs in each transaction against a small built-in allowlist:
    - Raydium
    - Orca Whirlpool
    - Phoenix
    - Jupiter (included in constants; counts show up if it appears in parsed program IDs)

- **How active it is (daily tx + trend)**
  - `activity.dailyTx`
  - `activity.avgTxPerDay`
  - `activity.trendLast7VsPrev7` (only meaningful if you fetch enough days of data)

- **Who the users are (unique wallets, concentrated vs broad)**
  - `users.uniqueFeePayers`
  - `users.uniqueSigners`
  - `users.topFeePayers` / `users.topSigners`

- **Who controls it (deployer/upgrade authority/related wallets)**
  - If it is an **upgradeable program**, the script extracts:
    - `control.programData`
    - `control.upgradeAuthority`
  - This uses the account layout of `BPFLoaderUpgradeab1e...`.

- **SOL balance / balance context**
  - `balances.currentLamports`
  - `balances.currentSOL`

### Part 2 — Opportunity Assessment mapping

The script adds a `part2` section with:

- `part2.swaps`
  - A **SOL swap volume estimate** using:
    - It detects WSOL mint (`So111...`) balance movement using `meta.preTokenBalances/postTokenBalances`.
    - It sums **absolute WSOL balance deltas** as a rough SOL-denominated flow proxy.
  - Fields:
    - `wsolSwapLikeTxCount`
    - `windowSwapVolumeSOL`
    - `estWeeklySwapVolumeSOL` (scaled by `7 / windowDays`)

- `part2.competition`
  - Reads ComputeBudget program instructions and tries to decode `SetComputeUnitPrice` to measure priority fee pressure.
  - Fields:
    - `computeUnitPriceMicroLamports.sampleCount/min/max`

- `part2.redFlags`
  - Simple red-flag heuristics:
    - `topFeePayerShare`: if one fee payer dominates, it may be a single-bot flow.
    - `failedTxRate`: elevated failure rate can indicate spam or brittle MEV strategies.

Additionally, overall fee pressure is included in Part 1 `activity.sol.totalFeesSOL`.

## Function-by-function explanation

Below is a guide to what each function does.

### Core utilities

- `sleep(ms)`
  - Promise-based delay helper.

- `isRateLimitError(err)`
  - Detects RPC 429 errors.

- `isForbiddenError(err)`
  - Detects RPC 403 errors.

- `withRetries(fn, { maxRetries, baseDelayMs })`
  - Retries a function on 429 errors with exponential backoff.

- `createRateLimiter({ minDelayMs })`
  - Simple global queue that enforces a minimum delay between RPC calls.

### CLI + formatting

- `parseArgs(argv)`
  - Parses CLI flags into an args object.

- `dayKeyFromUnixSeconds(ts)`
  - Converts `blockTime` to a `YYYY-MM-DD` key.

- `topN(counterObj, n)`
  - Returns top-N entries of a frequency map.

### RPC connection + address type

- `createConnectionWithFallback(args)`
  - Creates a `Connection`.
  - If you didn’t explicitly provide an RPC, it can try fallbacks.

- `getAddressType(connection, address)`
  - Uses `getAccountInfo` to classify the address.
  - Key logic:
    - `executable === true` → program
    - `owner === SystemProgram` → system account
    - `owner === Token Program` → SPL token account or mint

### Transaction fetching

- `fetchSignatures(connection, address, maxTx, minBlockTime, rpcOpts)`
  - Paginates `getSignaturesForAddress` up to `maxTx` and stops when `blockTime < minBlockTime`.

- `mapWithConcurrency(items, concurrency, fn)`
  - Runs async tasks with a concurrency limit.
  - Used for parallel `getTransaction` fetching.

### Parsing helpers (critical)

- `normalizePubkey(k)`
  - Normalizes a public key-like value to a base58 string.

- `getAllAccountKeysFromTx(tx)`
  - Returns an array of account keys for both legacy and v0 transactions.
  - Handles loaded addresses (address lookup tables) when present.

- `getNumRequiredSignatures(tx)`
  - Reads `message.header.numRequiredSignatures`.

- `inferUsersFromTx(tx)`
  - Returns:
    - `feePayer` (accountKeys[0])
    - `signers` (first `numRequiredSignatures` account keys)

- `collectProgramIdsFromTx(tx)`
  - Extracts invoked program IDs from:
    - outer instructions
    - inner instructions

- `solDeltaForAddress(tx, address)`
  - Computes lamport balance delta for `address` using `meta.preBalances/postBalances`.

### Program control / upgrade authority

- `getUpgradeableProgramInfo(connection, programId)`
  - If the program is owned by `BPFLoaderUpgradeab1e...`, extracts:
    - ProgramData address
    - Upgrade authority (if present)

### Part 2 helpers

- `getComputeUnitPriceMicroLamports(tx)`
  - Looks for ComputeBudget instructions and decodes `SetComputeUnitPrice`.

- `getWsolDeltaLamports(tx)`
  - Uses `preTokenBalances/postTokenBalances` to compute WSOL deltas.
  - Used as the swap-volume proxy for.

### Entry point

- `main()`
  - Orchestrates the entire pipeline:
    - parse args
    - connect to RPC
    - classify address
    - fetch signatures
    - fetch + parse transactions
    - compute metrics
    - write `report.json`
    - print console summary

## Practical guidance / caveats

- **Public RPCs** often 429/403.
  - Use `--rpc` with a reliable provider (Helius, QuickNode, Alchemy, Triton).

- **Averages are sample-based**
  - If `maxTx` caps your history, treat counts/volume as *at least* within that sample.

- **swap volume is a proxy**
  - WSOL movement includes wrap/unwrap and non-swap flows.
  - For more accurate swap volume, implement Option B (token pricing + full swap decoding).
