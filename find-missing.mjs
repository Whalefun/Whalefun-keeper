// 找出「持有 LP 分红金库」里未登记的 LP 持有人(漏登)。
//
// 为什么不用 backfill-holders.mjs:那个脚本靠 Etherscan 免费档拉 BSC 日志,现在返回
// "Free API access is not supported for this chain" —— 已失效。这里改成直接从公共 RPC
// 反向扫 LP 的 Transfer 事件,不依赖任何第三方 API。
//
// 终止条件不是"扫到创世",而是"找齐缺口":缺口 = 合约可分配 LP 总量 − 已登记者 LP 之和。
// 凑够就停,所以漏登的人越靠近当下,收工越快。
//
// 用法:
//   node find-missing.mjs <vault>                 扫描(可反复跑,自动从上次断点续)
//   BROADCAST=1 PK=0x.. node find-missing.mjs <vault>   扫完顺带 addHolders 补登
//   可选:BUDGET_S=600(单次扫描秒数上限)、RESET=1(丢弃断点重扫)
import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "fs";

const VAULT = process.argv[2] || "0x69EAd3E6387EEb1C4A8A84B3A3C9441A89e4A867";
const STATE = `./.find-missing-${VAULT.slice(2, 10).toLowerCase()}.json`;
const BUDGET = Number(process.env.BUDGET_S || 600) * 1000;
const T = ethers.id("Transfer(address,address,uint256)");

// 每家的 getLogs 跨度上限是实测出来的(见本轮探测:48.club/publicnode 5000,drpc 10000)。
// PAR = 每家同时打几枪 —— 瓶颈是往返延迟不是带宽,并发比加大跨度更有效。
const PAR = 4;
const EP = [
  ["https://rpc-bsc.48.club", 5000],
  ["https://bsc-rpc.publicnode.com", 5000],
  ["https://bsc.drpc.org", 10000],
];
// 每个 RPC 请求都必须有超时。ethers 对"连上了但永不回包"的节点不会自己放弃 ——
// 踩过:drpc 挂死不返回,而 balOf 轮流打三家,每第三个读取就永久卡住,
// 开头那 92 个已登记者的余额永远读不完,脚本跑满 600s 一行输出都没有,看着像"扫不到人"。
const TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 12000);
const withTimeout = (pr, label = "") =>
  Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error(`RPC 超时 ${TIMEOUT_MS}ms ${label}`)), TIMEOUT_MS))]);

const all = EP.map(([u, span]) => ({ p: new ethers.JsonRpcProvider(u, undefined, { batchMaxCount: 1 }), span, u }));
// 开跑前先体检,当场踢掉死掉的那家(公共节点时好时坏,今天通不代表明天通)
const health = await Promise.all(all.map(async (x) => {
  try { await withTimeout(x.p.getBlockNumber(), x.u); return true; }
  catch { console.log(`  ⚠️ 节点不可用,本轮跳过:${x.u}`); return false; }
}));
const provs = all.filter((_, i) => health[i]);
if (!provs.length) { console.error("所有 RPC 节点都不可用,退出"); process.exit(1); }
console.log(`可用节点 ${provs.length}/${all.length}:${provs.map((x) => x.u).join(", ")}\n`);
const read = provs[0].p;

const vault = new ethers.Contract(VAULT, [
  "function lpToken() view returns (address)",
  "function getVaultStats() view returns (uint256,uint256,uint256,uint256,uint256)",
  "function getHolders(uint256,uint256) view returns (address[])",
  "function addHolders(address[])",
], read);

const LP = (await vault.lpToken()).toLowerCase();
const lp = new ethers.Contract(LP, ["function balanceOf(address) view returns (uint256)"], read);
const f = (x) => ethers.formatEther(x);

// 并发取余额:轮流打三家,避开单家限速
let rr = 0;
const balOf = (a) => withTimeout(new ethers.Contract(LP, ["function balanceOf(address) view returns (uint256)"], provs[rr++ % provs.length].p).balanceOf(a), "balanceOf");
// 重试到底,不允许静默失败:一次读不到余额如果被当成 0,已登记者的 LP 之和就被低估,
// 缺口随之虚高(踩过:缺口被算成 136 LP,实际 81.8),扫描还会因为凑不满目标而永不收工。
async function pool(items, fn, n = 8) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      for (let attempt = 0; ; attempt++) {
        try { out[k] = await fn(items[k]); break; }
        catch (e) {
          if (attempt >= 5) throw new Error(`读取失败(已重试 ${attempt} 次):${e.shortMessage || e.message}`);
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        }
      }
    }
  }));
  return out;
}

const [, distLp] = await vault.getVaultStats();
const regList = (await vault.getHolders(0, 500)).map((a) => a.toLowerCase());
const reg = new Set(regList);
const regBals = await pool(regList, balOf);
const regSum = regBals.reduce((a, b) => a + (b ?? 0n), 0n);
const TARGET = distLp - regSum;
console.log(`LP           : ${LP}`);
console.log(`可分配 LP    : ${f(distLp)}`);
console.log(`已登记 ${reg.size} 个 : ${f(regSum)}`);
console.log(`缺口(漏登)  : ${f(TARGET)}   ← 找齐即停\n`);

const latest = await read.getBlockNumber();
let st = { from: latest, seen: [], missing: {} };
if (existsSync(STATE) && !process.env.RESET) {
  st = JSON.parse(readFileSync(STATE, "utf8"));
  console.log(`续跑:上次扫到 ${st.from}(已回溯 ${latest - st.from} 块),已命中 ${Object.keys(st.missing).length} 个\n`);
}
const seen = new Set(st.seen);
const missing = new Map(Object.entries(st.missing).map(([k, v]) => [k, BigInt(v)]));
let found = [...missing.values()].reduce((a, b) => a + b, 0n);
let from = st.from;

const SKIP = new Set([ethers.ZeroAddress.toLowerCase(), "0x000000000000000000000000000000000000dead", LP, VAULT.toLowerCase()]);
const save = () => writeFileSync(STATE, JSON.stringify({
  from, seen: [...seen], missing: Object.fromEntries([...missing].map(([k, v]) => [k, v.toString()])),
}));

// 取一段区块的 Transfer 日志。绝不 .catch(()=>null) 一走了之 —— 那样一家限速就整段被悄悄丢掉,
// 扫描留下看不见的洞(踩过:第一轮扫到的 8 个小户,第二轮就"消失"了)。
// 失败后先在撑得住这个跨度的节点之间轮换;还不行就对半切 —— 10000 块的段只有 drpc 接得下,
// 它一超时就没有备胎,切成两半后 5000 上限的两家立刻能顶上。
async function fetchRange(lo, hi, depth = 0) {
  const span = hi - lo + 1;
  const fit = provs.filter((x) => x.span >= span);
  if (fit.length) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const q = fit[(attempt + rr++) % fit.length].p;
      try { return await withTimeout(q.getLogs({ address: LP, topics: [T], fromBlock: lo, toBlock: hi }), "getLogs"); }
      catch { await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); }
    }
  }
  if (span > 200 && depth < 6) {
    const mid = lo + Math.floor(span / 2);
    const [a, b] = await Promise.all([fetchRange(lo, mid - 1, depth + 1), fetchRange(mid, hi, depth + 1)]);
    return a === null || b === null ? null : [...a, ...b];
  }
  console.log(`  ⚠️ 块段 ${lo}-${hi} 切到底仍失败,已跳过(结果可能不全)`);
  return null;
}

const t0 = Date.now();
let rounds = 0;
// found 只要摸到缺口就停;留 1e12 wei 容差,因为池子还在交易、余额会微动
while (from > 0 && found < TARGET - 10n ** 12n && Date.now() - t0 < BUDGET) {
  const jobs = [];
  let cursor = from;
  for (let k = 0; k < PAR; k++) {
    for (const { p, span } of provs) {
      const hi = cursor, lo = Math.max(0, cursor - span + 1);
      if (hi <= 0) break;
      jobs.push(fetchRange(lo, hi));
      cursor = lo - 1;
    }
  }
  const res = await Promise.all(jobs);
  from = cursor;
  rounds++;

  const fresh = [];
  for (const logs of res) {
    if (!logs) continue;
    for (const lg of logs) {
      if (lg.topics.length < 3) continue;
      for (const t of [lg.topics[1], lg.topics[2]]) {
        const a = ("0x" + t.slice(26)).toLowerCase();
        if (seen.has(a) || SKIP.has(a) || reg.has(a)) continue;
        seen.add(a); fresh.push(a);
      }
    }
  }
  if (fresh.length) {
    const bals = await pool(fresh, balOf);
    fresh.forEach((a, i) => {
      const b = bals[i];
      if (b && b > 0n) {
        missing.set(a, b); found += b;
        console.log(`  漏登 ${a}  LP=${f(b)}   累计 ${f(found)} / ${f(TARGET)}`);
      }
    });
  }
  if (rounds % 5 === 0) {
    save();
    console.log(`… 扫到 ${from}(回溯 ${latest - from} 块 / ${Math.round((Date.now() - t0) / 1000)}s),命中 ${missing.size} 个 = ${f(found)}`);
  }
}
save();

const done = found >= TARGET - 10n ** 12n;
console.log(`\n=== 漏登 ${missing.size} 个,合计 ${f(found)} LP,缺口 ${f(TARGET)} ${done ? "✅ 已找齐" : `(还差 ${f(TARGET - found)},再跑一次续扫)`} ===`);
const out = [...missing].sort((a, b) => (a[1] < b[1] ? 1 : -1));
for (const [a, b] of out) console.log(`${f(b).padStart(22)}  ${a}`);

if (!process.env.BROADCAST) { console.log("\n(未广播补登 —— 加 BROADCAST=1 PK=0x… 才发 addHolders)"); process.exit(0); }
const wallet = new ethers.Wallet(process.env.PK, read);
console.log(`\n签名钱包 ${wallet.address}`);
const vw = vault.connect(wallet);
const addrs = out.map(([a]) => a);
for (let i = 0; i < addrs.length; i += 100) {
  const slice = addrs.slice(i, i + 100);
  const tx = await vw.addHolders(slice, { gasLimit: 6_000_000 });
  const rc = await tx.wait();
  console.log(`addHolders ${slice.length} 个 ✅ ${rc.hash}`);
}
