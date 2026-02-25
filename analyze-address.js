#!/usr/bin/env node

const { Connection, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const BPF_UPGRADEABLE_LOADER_ID = "BPFLoaderUpgradeab1e11111111111111111111111";
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

const DEX_PROGRAM_IDS = {
  Jupiter: "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
  Raydium: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  OrcaWhirlpool: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  Phoenix: "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",
  OpenBook: "openbook111111111111111111111111111111111111"
};

const DEFAULT_RPC_URL =
  "https://solana-mainnet.g.alchemy.com/v2/6fe4nl7so0S9oC-IsBu4c";
const RPC_FALLBACK_URLS = [
  DEFAULT_RPC_URL,
  "https://solana-api.projectserum.com"
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err) {
  const msg = String(err?.message || err || "");
  return msg.includes("429") || msg.toLowerCase().includes("too many requests");
}

function isForbiddenError(err) {
  const msg = String(err?.message || err || "");
  return msg.includes("403") || msg.toLowerCase().includes("forbidden");
}

async function withRetries(fn, { maxRetries, baseDelayMs }) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (attempt > maxRetries) throw e;

      const backoff = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * Math.min(250, backoff * 0.1));
      const delay = backoff + jitter;

      if (isRateLimitError(e)) {
        process.stderr.write(
          `RPC 429 rate limit. Backing off ${delay}ms (attempt ${attempt}/${maxRetries})...\n`
        );
        await sleep(delay);
        continue;
      }

      throw e;
    }
  }
}

function createRateLimiter({ minDelayMs }) {
  let chain = Promise.resolve();
  let nextAllowed = 0;
  return async function rateLimit() {
    chain = chain.then(async () => {
      const now = Date.now();
      const wait = Math.max(0, nextAllowed - now);
      nextAllowed = Math.max(now, nextAllowed) + minDelayMs;
      if (wait > 0) await sleep(wait);
    });
    await chain;
  };
}

function parseArgs(argv) {
  const out = {
    address: null,
    rpc: process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL,
    rpcProvided: false,
    maxTx: 500,
    days: 14,
    concurrency: 3,
    verbose: false,
    minDelayMs: 150,
    maxRetries: 8,
    baseRetryDelayMs: 500,
    outJson: "report.json"
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--address" && next) {
      out.address = next;
      i++;
    } else if (a === "--rpc" && next) {
      out.rpc = next;
      out.rpcProvided = true;
      i++;
    } else if (a === "--maxTx" && next) {
      out.maxTx = Number(next);
      i++;
    } else if (a === "--days" && next) {
      out.days = Number(next);
      i++;
    } else if (a === "--concurrency" && next) {
      out.concurrency = Number(next);
      i++;
    } else if (a === "--verbose") {
      out.verbose = true;
    } else if (a === "--minDelayMs" && next) {
      out.minDelayMs = Number(next);
      i++;
    } else if (a === "--maxRetries" && next) {
      out.maxRetries = Number(next);
      i++;
    } else if (a === "--baseRetryDelayMs" && next) {
      out.baseRetryDelayMs = Number(next);
      i++;
    } else if (a === "--out" && next) {
      out.outJson = next;
      i++;
    }
  }

  if (!out.address) {
    throw new Error("Missing --address <base58>");
  }
  if (!Number.isFinite(out.maxTx) || out.maxTx <= 0) {
    throw new Error("--maxTx must be a positive number");
  }
  if (!Number.isFinite(out.days) || out.days <= 0) {
    throw new Error("--days must be a positive number");
  }
  if (!Number.isFinite(out.concurrency) || out.concurrency <= 0) {
    throw new Error("--concurrency must be a positive number");
  }
  if (!Number.isFinite(out.minDelayMs) || out.minDelayMs < 0) {
    throw new Error("--minDelayMs must be >= 0");
  }
  if (!Number.isFinite(out.maxRetries) || out.maxRetries < 0) {
    throw new Error("--maxRetries must be >= 0");
  }
  if (!Number.isFinite(out.baseRetryDelayMs) || out.baseRetryDelayMs <= 0) {
    throw new Error("--baseRetryDelayMs must be a positive number");
  }

  return out;
}

async function createConnectionWithFallback(args) {
  const makeConn = (url) =>
    new Connection(url, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 60_000
    });

  if (args.rpcProvided || process.env.SOLANA_RPC_URL) {
    return { connection: makeConn(args.rpc), rpcUrl: args.rpc, fallbackTried: [] };
  }

  const fallbackTried = [];
  for (const url of RPC_FALLBACK_URLS) {
    fallbackTried.push(url);
    const connection = makeConn(url);
    try {
      await withRetries(() => connection.getLatestBlockhash("confirmed"), {
        maxRetries: 2,
        baseDelayMs: 500
      });
      return { connection, rpcUrl: url, fallbackTried };
    } catch (e) {
      if (isForbiddenError(e) || isRateLimitError(e)) {
        continue;
      }
      continue;
    }
  }

  return { connection: makeConn(DEFAULT_RPC_URL), rpcUrl: DEFAULT_RPC_URL, fallbackTried };
}

function dayKeyFromUnixSeconds(ts) {
  const d = new Date(ts * 1000);
  return d.toISOString().slice(0, 10);
}

function short(n, k = 8) {
  if (!n || typeof n !== "string") return n;
  if (n.length <= k * 2) return n;
  return `${n.slice(0, k)}…${n.slice(-k)}`;
}

function topN(counterObj, n) {
  return Object.entries(counterObj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

async function getAddressType(connection, address) {
  const pubkey = new PublicKey(address);
  const info = await connection.getAccountInfo(pubkey, { commitment: "confirmed" });

  if (!info) {
    return {
      address,
      exists: false,
      type: "unknown",
      reason: "getAccountInfo returned null",
      owner: null,
      executable: false,
      lamports: 0,
      dataLength: 0
    };
  }

  const owner = info.owner.toBase58();
  const executable = !!info.executable;

  let type = "account";
  if (executable) type = "program";
  else if (owner === SYSTEM_PROGRAM_ID) type = "system_account";
  else if (owner === TOKEN_PROGRAM_ID) type = "spl_token_account_or_mint";
  else if (owner === TOKEN_2022_PROGRAM_ID) type = "spl_token_2022_account_or_mint";

  return {
    address,
    exists: true,
    type,
    reason: executable
      ? "Account is executable"
      : `Owner program is ${owner}`,
    owner,
    executable,
    lamports: info.lamports,
    dataLength: info.data?.length || 0
  };
}

async function fetchSignatures(connection, address, maxTx, minBlockTime, rpcOpts) {
  const pubkey = new PublicKey(address);
  const out = [];
  let before = undefined;

  while (out.length < maxTx) {
    const batchLimit = Math.min(1000, maxTx - out.length);
    await rpcOpts.rateLimit();
    const sigs = await withRetries(
      () =>
        connection.getSignaturesForAddress(pubkey, {
          limit: batchLimit,
          before
        }),
      rpcOpts.retries
    );

    if (!sigs || sigs.length === 0) break;

    for (const s of sigs) {
      if (minBlockTime && s.blockTime && s.blockTime < minBlockTime) {
        return out;
      }
      out.push(s);
    }

    before = sigs[sigs.length - 1].signature;

    if (minBlockTime && sigs[sigs.length - 1].blockTime && sigs[sigs.length - 1].blockTime < minBlockTime) {
      break;
    }
  }

  return out;
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

function normalizePubkey(k) {
  if (!k) return null;
  if (typeof k === "string") return k;
  if (typeof k?.toBase58 === "function") return k.toBase58();
  if (k?.pubkey && typeof k.pubkey?.toBase58 === "function") return k.pubkey.toBase58();
  if (typeof k?.pubkey === "string") return k.pubkey;
  return null;
}

function getAllAccountKeysFromTx(tx) {
  const msg = tx?.transaction?.message;
  const meta = tx?.meta;
  if (!msg) return [];

  if (typeof msg.getAccountKeys === "function") {
    const lookups = meta?.loadedAddresses
      ? {
          writable: (meta.loadedAddresses.writable || []).map((x) => new PublicKey(x)),
          readonly: (meta.loadedAddresses.readonly || []).map((x) => new PublicKey(x))
        }
      : undefined;
    try {
      const ak = msg.getAccountKeys({ accountKeysFromLookups: lookups });
      if (ak?.staticAccountKeys) {
        const fromLookups = ak.accountKeysFromLookups || { writable: [], readonly: [] };
        const all = [...ak.staticAccountKeys, ...fromLookups.writable, ...fromLookups.readonly];
        return all.map(normalizePubkey).filter(Boolean);
      }
      if (typeof ak?.keySegments === "function") {
        return ak.keySegments().flat().map(normalizePubkey).filter(Boolean);
      }
      return [];
    } catch (_) {
      // fall through
    }
  }

  const keys = msg.accountKeys || [];
  return keys.map(normalizePubkey).filter(Boolean);
}

function getNumRequiredSignatures(tx) {
  const msg = tx?.transaction?.message;
  return msg?.header?.numRequiredSignatures || 0;
}

function collectProgramIdsFromTx(tx) {
  const ids = [];

  const msg = tx?.transaction?.message;
  const meta = tx?.meta;
  const keys = getAllAccountKeysFromTx(tx);

  const outer = msg?.compiledInstructions || msg?.instructions || [];
  for (const ix of outer) {
    if (ix?.programId) ids.push(normalizePubkey(ix.programId));
    else if (typeof ix?.programIdIndex === "number") {
      const k = keys[ix.programIdIndex];
      if (k) ids.push(k);
    }
  }

  const inner = meta?.innerInstructions || [];
  for (const iix of inner) {
    for (const ix of iix.instructions || []) {
      if (ix?.programId) ids.push(normalizePubkey(ix.programId));
      else if (typeof ix?.programIdIndex === "number") {
        const k = keys[ix.programIdIndex];
        if (k) ids.push(k);
      }
    }
  }

  return ids;
}

function inferUsersFromTx(tx) {
  const keys = getAllAccountKeysFromTx(tx);
  const numReq = getNumRequiredSignatures(tx);
  const feePayer = keys.length ? keys[0] : null;
  const signers = numReq > 0 ? keys.slice(0, numReq) : [];
  return { feePayer, signers };
}

function solDeltaForAddress(tx, address) {
  const meta = tx?.meta;
  const keys = getAllAccountKeysFromTx(tx);

  let idx = -1;
  for (let i = 0; i < keys.length; i++) {
    const pk = keys[i];
    if (pk === address) {
      idx = i;
      break;
    }
  }

  if (idx === -1) return { found: false, netLamports: 0, absLamports: 0 };
  const pre = meta?.preBalances?.[idx];
  const post = meta?.postBalances?.[idx];
  if (typeof pre !== "number" || typeof post !== "number") return { found: true, netLamports: 0, absLamports: 0 };
  const net = post - pre;
  const abs = Math.abs(net);
  return { found: true, netLamports: net, absLamports: abs };
}

function readU32LE(buf, off) {
  return buf.readUInt32LE(off);
}

function readU64LE(buf, off) {
  const lo = buf.readUInt32LE(off);
  const hi = buf.readUInt32LE(off + 4);
  return BigInt(hi) * 4294967296n + BigInt(lo);
}

function getComputeUnitPriceMicroLamports(tx) {
  const msg = tx?.transaction?.message;
  if (!msg) return null;
  const keys = getAllAccountKeysFromTx(tx);
  const ixs = msg.compiledInstructions || msg.instructions || [];

  for (const ix of ixs) {
    let programId = null;
    if (ix?.programId) programId = normalizePubkey(ix.programId);
    else if (typeof ix?.programIdIndex === "number") programId = keys[ix.programIdIndex];
    if (programId !== COMPUTE_BUDGET_PROGRAM_ID) continue;

    // In web3.js getTransaction, instruction data is typically base58 string.
    const dataB58 = ix?.data;
    if (!dataB58 || typeof dataB58 !== "string") continue;
    let buf;
    try {
      const bs58 = require("bs58");
      buf = bs58.decode(dataB58);
    } catch (_) {
      continue;
    }
    if (!buf || buf.length < 1) continue;
    const tag = buf[0];
    // 3 = SetComputeUnitPrice (u64 microLamports)
    if (tag === 3 && buf.length >= 1 + 8) {
      const v = readU64LE(Buffer.from(buf), 1);
      return Number(v);
    }
  }
  return null;
}

function getWsolDeltaLamports(tx) {
  const meta = tx?.meta;
  const pre = meta?.preTokenBalances || [];
  const post = meta?.postTokenBalances || [];

  const indexToPre = new Map();
  for (const b of pre) {
    if (b?.mint !== WSOL_MINT) continue;
    indexToPre.set(b.accountIndex, b);
  }

  let bestAbs = 0;
  let bestDelta = 0;

  for (const b of post) {
    if (b?.mint !== WSOL_MINT) continue;
    const p = indexToPre.get(b.accountIndex);
    const preAmt = Number(p?.uiTokenAmount?.amount || 0);
    const postAmt = Number(b?.uiTokenAmount?.amount || 0);
    const delta = postAmt - preAmt;
    const abs = Math.abs(delta);
    if (abs > bestAbs) {
      bestAbs = abs;
      bestDelta = delta;
    }
  }

  return { deltaLamports: bestDelta, absLamports: bestAbs };
}

async function getUpgradeableProgramInfo(connection, programId) {
  const programPk = new PublicKey(programId);
  const acc = await connection.getAccountInfo(programPk, { commitment: "confirmed" });
  if (!acc || acc.owner.toBase58() !== BPF_UPGRADEABLE_LOADER_ID) return null;

  const data = acc.data;
  if (!Buffer.isBuffer(data) || data.length < 4 + 32) return null;
  const stateTag = readU32LE(data, 0);
  if (stateTag !== 2) return null;
  const programDataPk = new PublicKey(data.slice(4, 36)).toBase58();

  const programDataAcc = await connection.getAccountInfo(new PublicKey(programDataPk), { commitment: "confirmed" });
  if (!programDataAcc) {
    return { programData: programDataPk, upgradeAuthority: null };
  }

  const pd = programDataAcc.data;
  if (!Buffer.isBuffer(pd) || pd.length < 4 + 8 + 4) {
    return { programData: programDataPk, upgradeAuthority: null };
  }
  const pdTag = readU32LE(pd, 0);
  if (pdTag !== 3) {
    return { programData: programDataPk, upgradeAuthority: null };
  }

  const _slot = readU64LE(pd, 4);
  const opt = readU32LE(pd, 12);
  if (opt === 0) {
    return { programData: programDataPk, upgradeAuthority: null };
  }
  if (pd.length < 16 + 32) {
    return { programData: programDataPk, upgradeAuthority: null };
  }
  const ua = new PublicKey(pd.slice(16, 48)).toBase58();
  return { programData: programDataPk, upgradeAuthority: ua };
}

async function main() {
  const args = parseArgs(process.argv);
  const { connection, rpcUrl, fallbackTried } = await createConnectionWithFallback(args);
  args.rpc = rpcUrl;

  const rpcOpts = {
    rateLimit: createRateLimiter({ minDelayMs: args.minDelayMs }),
    retries: { maxRetries: args.maxRetries, baseDelayMs: args.baseRetryDelayMs }
  };

  const now = Math.floor(Date.now() / 1000);
  const minBlockTime = now - args.days * 86400;

  await rpcOpts.rateLimit();
  let addressMeta;
  try {
    addressMeta = await withRetries(
      () => getAddressType(connection, args.address),
      rpcOpts.retries
    );
  } catch (e) {
    const hint = isForbiddenError(e)
      ? "This RPC endpoint returned 403 Forbidden. Pass a different endpoint via --rpc or SOLANA_RPC_URL (Helius/QuickNode/Triton/etc.)."
      : isRateLimitError(e)
        ? "This RPC endpoint is rate limiting (429). Try increasing --minDelayMs or use a paid RPC via --rpc / SOLANA_RPC_URL."
        : "";
    const tried = fallbackTried && fallbackTried.length ? `RPC fallback tried: ${fallbackTried.join(", ")}` : "";
    throw new Error([`failed to get info about account ${args.address}: ${String(e?.message || e)}`, hint, tried].filter(Boolean).join("\n"));
  }

  const sigs = await fetchSignatures(connection, args.address, args.maxTx, minBlockTime, rpcOpts);
  const dailyTx = new Counter();
  const programCounts = new Counter();
  const protocolCounts = new Counter();
  const feePayers = new Counter();
  const signers = new Counter();
  let netLamports = 0;
  let absLamports = 0;
  let totalFeesLamports = 0;

  let swapSolAbsLamports = 0;
  let swapTxCount = 0;
  const cuPriceMicroLamports = [];

  const currentBalanceLamports = addressMeta.lamports;
  const currentBalanceSOL = currentBalanceLamports / LAMPORTS_PER_SOL;

  let upgradeableInfo = null;
  if (addressMeta.type === "program" && addressMeta.owner === BPF_UPGRADEABLE_LOADER_ID) {
    await rpcOpts.rateLimit();
    try {
      upgradeableInfo = await withRetries(
        () => getUpgradeableProgramInfo(connection, args.address),
        rpcOpts.retries
      );
    } catch (_) {
      upgradeableInfo = null;
    }
  }

  const txItems = await mapWithConcurrency(sigs, args.concurrency, async (s, i) => {
    if (args.verbose && i % 25 === 0) {
      process.stderr.write(`fetching tx ${i + 1}/${sigs.length}...\n`);
    }
    try {
      await rpcOpts.rateLimit();
      const tx = await withRetries(
        () =>
          connection.getTransaction(s.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0
          }),
        rpcOpts.retries
      );
      return { signature: s.signature, blockTime: s.blockTime || null, err: s.err || null, tx };
    } catch (e) {
      return { signature: s.signature, blockTime: s.blockTime || null, err: { fetchError: String(e?.message || e) }, tx: null };
    }
  });

  for (const item of txItems) {
    if (item.blockTime) {
      dailyTx.add(dayKeyFromUnixSeconds(item.blockTime));
    }

    if (!item.tx) continue;

    const { feePayer, signers: txSigners } = inferUsersFromTx(item.tx);
    if (feePayer) feePayers.add(feePayer);
    for (const ss of txSigners) signers.add(ss);

    const fee = item.tx?.meta?.fee;
    if (typeof fee === "number") totalFeesLamports += fee;

    const cuPrice = getComputeUnitPriceMicroLamports(item.tx);
    if (typeof cuPrice === "number" && Number.isFinite(cuPrice)) {
      cuPriceMicroLamports.push(cuPrice);
    }

    const ids = collectProgramIdsFromTx(item.tx).filter(Boolean);
    for (const id of ids) {
      programCounts.add(id);
      for (const [name, pid] of Object.entries(DEX_PROGRAM_IDS)) {
        if (id === pid) protocolCounts.add(name);
      }
    }

    const delta = solDeltaForAddress(item.tx, args.address);
    netLamports += delta.netLamports;
    absLamports += delta.absLamports;

    const wsol = getWsolDeltaLamports(item.tx);
    // If WSOL moved meaningfully, treat as SOL-denominated swap flow proxy.
    // (This also catches wrap/unwrap; it's a rough heuristic as requested.)
    if (wsol.absLamports > 0) {
      swapTxCount++;
      swapSolAbsLamports += wsol.absLamports;
    }
  }

  const daysObserved = Object.keys(dailyTx.map).length;
  const totalTx = sigs.length;
  const avgTxPerDay = daysObserved > 0 ? totalTx / daysObserved : 0;

  const dayKeys = Object.keys(dailyTx.map).sort();
  const last7 = dayKeys.slice(-7);
  const prev7 = dayKeys.slice(-14, -7);
  const sumFor = (arr) => arr.reduce((acc, k) => acc + (dailyTx.map[k] || 0), 0);
  const last7Count = sumFor(last7);
  const prev7Count = sumFor(prev7);
  const trend = prev7.length > 0 ? (last7Count - prev7Count) / Math.max(1, prev7Count) : null;

  const report = {
    input: {
      address: args.address,
      rpc: args.rpc,
      maxTx: args.maxTx,
      days: args.days,
      fetchedSignatures: totalTx
    },
    classification: addressMeta,
    balances: {
      currentLamports: currentBalanceLamports,
      currentSOL: currentBalanceSOL
    },
    control: {
      upgradeableLoader: addressMeta.owner === BPF_UPGRADEABLE_LOADER_ID,
      programData: upgradeableInfo?.programData || null,
      upgradeAuthority: upgradeableInfo?.upgradeAuthority || null
    },
    activity: {
      daysObserved,
      totalTx,
      avgTxPerDay,
      dailyTx: dailyTx.map,
      trendLast7VsPrev7: trend,
      sol: {
        netSOL: netLamports / LAMPORTS_PER_SOL,
        grossAbsSOL: absLamports / LAMPORTS_PER_SOL,
        totalFeesSOL: totalFeesLamports / LAMPORTS_PER_SOL
      }
    },
    part2: {
      option: "A",
      windowDays: args.days,
      swaps: {
        heuristic: "WSOL token balance abs delta across accounts (rough proxy; includes wrap/unwrap)",
        wsolSwapLikeTxCount: swapTxCount,
        windowSwapVolumeSOL: swapSolAbsLamports / LAMPORTS_PER_SOL,
        estWeeklySwapVolumeSOL:
          args.days > 0 ? (swapSolAbsLamports / LAMPORTS_PER_SOL) * (7 / args.days) : null
      },
      competition: {
        computeUnitPriceMicroLamports: {
          sampleCount: cuPriceMicroLamports.length,
          min: cuPriceMicroLamports.length ? Math.min(...cuPriceMicroLamports) : null,
          max: cuPriceMicroLamports.length ? Math.max(...cuPriceMicroLamports) : null
        }
      },
      redFlags: {
        topFeePayerShare:
          (() => {
            const total = Object.values(feePayers.map).reduce((a, b) => a + b, 0);
            const top = Object.values(feePayers.map).reduce((m, v) => (v > m ? v : m), 0);
            return total > 0 ? top / total : null;
          })(),
        failedTxCount: sigs.filter((s) => s.err != null).length,
        failedTxRate: totalTx > 0 ? sigs.filter((s) => s.err != null).length / totalTx : null
      }
    },
    users: {
      uniqueFeePayers: Object.keys(feePayers.map).length,
      uniqueSigners: Object.keys(signers.map).length,
      topFeePayers: topN(feePayers.map, 10).map((x) => ({ ...x, key: x.key })),
      topSigners: topN(signers.map, 10).map((x) => ({ ...x, key: x.key }))
    },
    protocols: {
      counts: protocolCounts.map,
      topPrograms: topN(programCounts.map, 15)
    },
    samples: {
      recentSignatures: sigs.slice(0, 20)
    }
  };

  const fs = require("fs");
  fs.writeFileSync(args.outJson, JSON.stringify(report, null, 2));

  const lines = [];
  lines.push(`Address: ${args.address}`);
  lines.push(`Type: ${addressMeta.type} (owner=${addressMeta.owner || "n/a"}, executable=${addressMeta.executable})`);
  lines.push(`Lookback: last ~${args.days} days, fetched ${totalTx} txs`);
  lines.push(`Activity: ~${avgTxPerDay.toFixed(1)} tx/day over ${daysObserved} active days`);
  if (trend !== null) {
    lines.push(`Trend: last7 vs prev7 = ${(trend * 100).toFixed(1)}% (${last7Count} vs ${prev7Count})`);
  }
  lines.push(`SOL throughput (rough): net=${(netLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL, gross_abs=${(absLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  lines.push(`Users (rough): unique fee payers=${report.users.uniqueFeePayers}, unique signers=${report.users.uniqueSigners}`);

  const protoEntries = Object.entries(protocolCounts.map).sort((a, b) => b[1] - a[1]);
  if (protoEntries.length) {
    lines.push("Protocol touches (heuristic):");
    for (const [name, c] of protoEntries) lines.push(`  - ${name}: ${c}`);
  } else {
    lines.push("Protocol touches (heuristic): none of the built-in DEX IDs matched");
  }

  lines.push(`Saved JSON: ${args.outJson}`);

  process.stdout.write(lines.join("\n") + "\n");
}

class Counter {
  constructor() {
    this.map = Object.create(null);
  }
  add(k, n = 1) {
    if (!k) return;
    this.map[k] = (this.map[k] || 0) + n;
  }
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e) + "\n");
  process.exit(1);
});
