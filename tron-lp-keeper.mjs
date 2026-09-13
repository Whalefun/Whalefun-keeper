/**
 * Whale.fun TRON keeper — LP-holder dividend vaults.
 *
 *   node tron-lp-keeper.mjs
 *
 * For every launch on the chain it finds the tax vault, registers LP holders it has not seen, and
 * runs a payout round when the pot is over the vault's threshold. Everything it calls is
 * permissionless: the hot wallet pays energy and holds no privileges over anyone's funds.
 *
 * ── Why the TRON version can do what the BSC one gave up on ──
 *
 * A vault cannot know who holds LP: the pair is a plain ERC20 with no hook, so holders either
 * register themselves or a keeper enumerates the LP token's Transfer events and registers them.
 * On BSC that second path was abandoned — every free endpoint caps eth_getLogs at 10 blocks or
 * refuses it outright, so a 15-minute window took 150 calls and tripped rate limits before it
 * finished, and registration fell back to a human reconciling the list by hand.
 *
 * TronGrid allows 5,000 blocks per getLogs call (measured: 5,001 returns "exceed max block range:
 * 5000"). TRON produces a block every 3 seconds, so a 15-minute cron covers ~300 blocks — one
 * request, with room to spare. That is the whole reason automatic registration is viable here and
 * was not on BSC, and it is why this keeper needs no scan cursor or resume file: each run simply
 * looks back further than the interval it runs on.
 *
 * ── Energy ──
 *
 * A payout round costs energy in proportion to the holder count — measured on Nile with a real
 * pair: about 6,600 per holder in the steady state, plus a one-off 25,000 the first time a payout
 * lands on an address that has never held TRX. The vault refuses to start a round it cannot finish
 * in one transaction, so this keeper reads `roundGasNeeded()` and skips (loudly) rather than
 * sending a call that would bounce off that guard.
 *
 * Setup:
 *   TRON_KEEPER_PK     fresh hot wallet, funded with TRX for energy. Never the deployer/guardian key.
 *   TRONGRID_API_KEY   free key from trongrid.io. Without it the shared 3 req/s limit applies.
 *   TRON_NETWORK       "tron" (mainnet) or "nile". Default nile.
 */

// tronweb 6 是具名导出:默认导入拿到的是模块命名空间,new 它会报 "not a constructor"
import { TronWeb } from "tronweb";

const NET = (process.env.TRON_NETWORK || "nile").toLowerCase();
const NETS = {
  nile: {
    host: "https://nile.trongrid.io",
    launchFactory: "TMaRHuvjPz4m4fNw4rtwabxRS88eiE7qz5",
    curveFactory: "TK4MouYJp1k3SvviVpgV3LEJTFuf17etqC",
  },
  tron: {
    host: "https://api.trongrid.io",
    launchFactory: "TNrevrNW66ELYkVTcXdHixcAEpKfyMwKzA",
    curveFactory: "TZ9kFGCg7xGq6iVyn4NEGjofviXFiuU6rP",
  },
};
const CFG = NETS[NET];
if (!CFG) throw new Error(`TRON_NETWORK 只能是 nile 或 tron,收到 "${NET}"`);

const HOST = process.env.TRON_HOST || CFG.host;
const LAUNCH_FACTORY = process.env.TRON_LAUNCH_FACTORY || CFG.launchFactory;
const CURVE_FACTORY = process.env.TRON_CURVE_FACTORY || CFG.curveFactory;
const API_KEY = process.env.TRONGRID_API_KEY || "";
const SCAN_BLOCKS = Number(process.env.SCAN_BLOCKS || 1500); // 3s blocks -> ~75 min of overlap
const MAX_RANGE = 5000; // TronGrid's hard cap, measured
const BUDGET_S = Number(process.env.BUDGET_S || 600);
const DRY_RUN = process.env.DRY_RUN === "1";
const ADD_BATCH = Number(process.env.ADD_BATCH || 40);

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const started = Date.now();
const timeUp = () => (Date.now() - started) / 1000 > BUDGET_S;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PK = (process.env.TRON_KEEPER_PK || "").replace(/^0x/, "");
if (!PK && !DRY_RUN) throw new Error("TRON_KEEPER_PK 未设置(只想看不发就加 DRY_RUN=1)");

const tw = new TronWeb({ fullHost: HOST, privateKey: PK || "01".repeat(32) });
const ME = tw.defaultAddress.base58;

const headers = API_KEY ? { "TRON-PRO-API-KEY": API_KEY } : {};

/** TronGrid rate-limits at 3 req/s without a key and escalates 429 -> 403; always back off. */
async function rpc(path, body) {
  let last = "";
  for (let i = 0; i < 6; i++) {
    if (i) await sleep(2500 * i);
    try {
      const r = await fetch(HOST + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        last = "HTTP " + r.status;
        continue;
      }
      const j = await r.json();
      if (j && j.Error) {
        last = String(j.Error).slice(0, 120);
        continue;
      }
      return j;
    } catch (e) {
      last = String(e.message || e).slice(0, 120);
    }
  }
  throw new Error(`${path} 连续失败(${last})`);
}

async function jsonRpc(method, params) {
  const j = await rpc("/jsonrpc", { jsonrpc: "2.0", id: 1, method, params });
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const pad = (b58) => tw.address.toHex(b58).slice(2).padStart(64, "0");
const hexAddr = (b58) => "0x" + tw.address.toHex(b58).slice(2).toLowerCase();
const fromTopic = (t) => tw.address.fromHex("41" + String(t).slice(-40));
const ZERO_HEX = "0".repeat(40);

/** A constant call. Returns "" when the call reverts, so a missing function reads as "not ours". */
async function read(contract, selector, parameter = "") {
  const r = await rpc("/wallet/triggerconstantcontract", {
    owner_address: ME,
    contract_address: contract,
    function_selector: selector,
    parameter,
    visible: true,
  });
  const cr = (r.constant_result || [])[0] || "";
  // result.result===true only says the API call worked; a revert arrives as Error(string) data.
  if (cr.startsWith("08c379a0") || (r.result && r.result.message)) return "";
  return cr;
}
const readU = async (c, s, p) => {
  const v = await read(c, s, p);
  return v ? BigInt("0x" + v) : null;
};
const readAddr = async (c, s, p) => {
  const v = await read(c, s, p);
  return v ? tw.address.fromHex("41" + v.slice(-40)) : null;
};

async function sendTx(contract, selector, parameter, feeLimit, label) {
  if (DRY_RUN) {
    console.log(`    [DRY_RUN] 会发:${label}`);
    return null;
  }
  const built = await tw.transactionBuilder.triggerSmartContract(
    contract,
    selector,
    { feeLimit, rawParameter: parameter },
    [],
    ME
  );
  if (!built.result || !built.result.result) throw new Error(`${label}: 构造失败`);
  const signed = await tw.trx.sign(built.transaction);
  const res = await tw.trx.sendRawTransaction(signed);
  if (!res.result) throw new Error(`${label}: 广播失败 ${JSON.stringify(res).slice(0, 160)}`);
  const id = res.txid || (res.transaction && res.transaction.txID);
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const info = await rpc("/wallet/gettransactioninfobyid", { value: id });
    if (info && info.receipt) {
      const ok = info.receipt.result === "SUCCESS";
      console.log(
        `    ${label}: ${info.receipt.result}  energy ${(info.receipt.energy_usage_total || 0).toLocaleString()}  tx ${id.slice(0, 12)}…`
      );
      return { ok, id };
    }
  }
  console.log(`    ${label}: 等不到回执(tx ${id.slice(0, 12)}…),下一轮再看`);
  return null;
}

/** Every launch this factory has registered, newest first. */
async function launches(factory) {
  const n = await readU(factory, "launchCount()");
  if (n === null) return [];
  const out = [];
  for (let i = Number(n) - 1; i >= 0 && !timeUp(); i--) {
    const v = await read(factory, "launches(uint256)", i.toString(16).padStart(64, "0"));
    if (!v) continue;
    const at = (k) => "41" + v.slice(k * 64 + 24, (k + 1) * 64);
    out.push({
      i,
      token: tw.address.fromHex(at(0)),
      taxVault: tw.address.fromHex(at(2)),
      pair: tw.address.fromHex(at(3)),
    });
  }
  return out;
}

/** LP addresses that moved recently. One getLogs call per 5,000 blocks. */
async function recentLpAddresses(lpToken, head) {
  const from = Math.max(0, head - SCAN_BLOCKS);
  const seen = new Set();
  for (let lo = from; lo <= head && !timeUp(); lo += MAX_RANGE) {
    const hi = Math.min(lo + MAX_RANGE - 1, head);
    const logs = await jsonRpc("eth_getLogs", [
      { fromBlock: "0x" + lo.toString(16), toBlock: "0x" + hi.toString(16), address: hexAddr(lpToken), topics: [TRANSFER_TOPIC] },
    ]);
    for (const l of logs || []) {
      for (const t of [l.topics[1], l.topics[2]]) {
        if (!t) continue;
        const a = String(t).slice(-40);
        if (a !== ZERO_HEX) seen.add(tw.address.fromHex("41" + a));
      }
    }
  }
  return [...seen];
}

async function processVault(v) {
  // roundGasNeeded() only exists on the LP-holder vault; anything else reads as "not ours".
  const need = await readU(v.taxVault, "roundGasNeeded()");
  if (need === null) return false;

  const lp = await readAddr(v.taxVault, "lpToken()");
  if (!lp || lp === tw.address.fromHex("41" + ZERO_HEX)) {
    console.log(`  ${v.taxVault}  LP 还没解析(代币尚未开盘),跳过`);
    return true;
  }

  const stats = await read(v.taxVault, "getVaultStats()");
  if (!stats) return true;
  const word = (k) => BigInt("0x" + stats.slice(k * 64, (k + 1) * 64));
  const holders = word(0), pot = word(2), rounds = word(4);
  const cond = (await readU(v.taxVault, "holderRewardCondition()")) ?? 0n;

  console.log(`  金库 ${v.taxVault}  (币 ${v.token})`);
  console.log(`    持有人 ${holders}  池子 ${Number(pot) / 1e6}  门槛 ${Number(cond) / 1e6}  已跑 ${rounds} 轮`);

  // ── 1. register whoever moved LP recently and is not on the list ──
  const head = Number(await jsonRpc("eth_blockNumber", []));
  const cands = await recentLpAddresses(lp, head);
  const missing = [];
  for (const a of cands) {
    if (timeUp()) break;
    if (a === v.taxVault || a === v.pair) continue;
    const reg = await readU(v.taxVault, "isRegistered(address)", pad(a));
    if (reg === 1n) continue;
    const ex = await readU(v.taxVault, "excludeHolder(address)", pad(a));
    if (ex === 1n) continue;
    missing.push(a);
  }
  if (missing.length) {
    console.log(`    最近动过 LP 的 ${cands.length} 个地址里,有 ${missing.length} 个没登记`);
    for (let i = 0; i < missing.length && !timeUp(); i += ADD_BATCH) {
      const batch = missing.slice(i, i + ADD_BATCH);
      const param =
        (32).toString(16).padStart(64, "0") + batch.length.toString(16).padStart(64, "0") + batch.map(pad).join("");
      // The vault itself drops anyone below the dust floor or holding nothing, so a wrong guess
      // here costs energy and nothing else.
      await sendTx(v.taxVault, "addHolders(address[])", param, 200_000_000, `登记 ${batch.length} 个`);
    }
  } else {
    console.log(`    最近动过 LP 的 ${cands.length} 个地址都已登记`);
  }

  // ── 2. run a round if the pot is over the threshold and we can afford the whole list ──
  if (pot < cond) {
    console.log(`    池子未达门槛,不派发`);
    return true;
  }
  const need2 = (await readU(v.taxVault, "roundGasNeeded()")) ?? need; // the list may have just grown
  const feeLimit = Math.min(Number(need2) * 100 * 1.2, 15_000_000_000); // energy price is 100 sun; TRON caps feeLimit at 15,000 TRX
  const bal = (await rpc("/wallet/getaccount", { address: ME, visible: true })).balance || 0;
  if (bal < feeLimit) {
    console.log(
      `    !! 这一轮要 ${Number(need2).toLocaleString()} 能量,keeper 余额 ${(bal / 1e6).toFixed(1)} TRX 撑不起 feeLimit ${(feeLimit / 1e6).toFixed(0)} TRX —— 先充值。金库拒绝开一轮它付不完的账,所以现在发了也只会空转。`
    );
    return true;
  }
  await sendTx(
    v.taxVault,
    "processReward(uint256)",
    BigInt(Math.ceil(Number(need2) * 1.1)).toString(16).padStart(64, "0"),
    feeLimit,
    `派发一轮(${holders} 人)`
  );
  return true;
}

(async () => {
  console.log(`Whale.fun TRON keeper — ${NET}`);
  console.log(`  keeper ${ME}${DRY_RUN ? "  [DRY_RUN]" : ""}`);
  const bal = (await rpc("/wallet/getaccount", { address: ME, visible: true })).balance || 0;
  console.log(`  余额 ${(bal / 1e6).toFixed(2)} TRX   API Key ${API_KEY ? "已配置" : "未配置(限 3 次/秒)"}`);

  let handled = 0;
  for (const factory of [LAUNCH_FACTORY, CURVE_FACTORY]) {
    const list = await launches(factory);
    console.log(`\n工厂 ${factory}:${list.length} 个发射`);
    for (const v of list) {
      if (timeUp()) {
        console.log("  时间预算用尽,本轮提前收尾(下一轮继续)");
        break;
      }
      if (v.taxVault === tw.address.fromHex("41" + ZERO_HEX)) continue;
      try {
        if (await processVault(v)) handled++;
      } catch (e) {
        console.error(`  金库 ${v.taxVault} 出错:`, e.message || e);
      }
    }
  }
  console.log(`\n处理了 ${handled} 个 LP 分红金库,用时 ${((Date.now() - started) / 1000).toFixed(0)}s`);
})().catch((e) => {
  console.error("失败:", e.message || e);
  process.exit(1);
});
