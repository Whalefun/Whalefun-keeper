// 全平台体检:所有「持有 LP 分红」金库的持有人登记覆盖率。
//
// 覆盖率 = 已登记持有人的 LP 之和 ÷ 合约可分配 LP 总量。
// 差额就是漏登 —— 那部分人一分分红都拿不到,他们的份额留在金库滚进下一轮。
// 纯链上读数,不依赖任何第三方 API(Etherscan 免费档已不覆盖 BSC)。
//
// 用法: node lp-coverage-audit.mjs
import { ethers } from "ethers";

// mint 发射工厂:launches(i) 返回结构体,金库在 .vault
const FACTORIES = [
  "0x1230B67525247DA20e56E9f8CAaA263ae670401a",
  "0xaDeb3eaEbA2fE20Afdb20529382e4395FaA2821c",
  "0x2196D9B1Ee3411a4C6E26a417861713151EcdC07",
  "0xB5AF6387ed653F3f15C01Da4031571Fd454DF22f",
];
// 内盘曲线工厂(当前 + 历代旧版,取自前端 chains.ts):launches(i) 只返回 token,
// 金库要再问 token.vault()。小金鱼这类 …aaaa 尾号的币全在这边,不在 mint 工厂里。
const CURVE_FACTORIES = [
  "0xD4bc1446A3A39465a56361DBA3209343E8985fD4",
  "0xcE2885A5655078BFF598034016a294e112F67eF8",
  "0x347Ce7035cc68aA157d06947fdC5050D41fBdb8B",
  "0x0151dCc278684971A0093A3b53802d59f5c4b1a4",
  "0xC1BbD4b8D0316cC4A5897250f7394900D33067B3",
  "0x7b9676AceD9cd7815D9350588e228166C51c29FB",
];
const RPCS = ["https://bsc-dataseed.bnbchain.org", "https://rpc-bsc.48.club", "https://bsc-rpc.publicnode.com"];
const provs = RPCS.map((u) => new ethers.JsonRpcProvider(u, undefined, { batchMaxCount: 1 }));
let rr = 0;
const P = () => provs[rr++ % provs.length];

const FACTORY_ABI = [
  "function launchCount() view returns (uint256)",
  "function launches(uint256) view returns (address token,address vault,address taxVault,address pair,address creator,uint256 createdAt)",
];
const VAULT_ABI = [
  "function lpToken() view returns (address)",
  "function holderRewardCondition() view returns (uint256)",
  "function getVaultStats() view returns (uint256,uint256,uint256,uint256,uint256)",
  "function getHolders(uint256,uint256) view returns (address[])",
];
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"];
const f = (x) => Number(ethers.formatEther(x));

async function pool(items, fn, n = 6) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null; } }
  }));
  return out;
}

// 1) 枚举全部发射
const all = [];
for (const fa of FACTORIES) {
  const c = new ethers.Contract(fa, FACTORY_ABI, P());
  let n = 0;
  try { n = Number(await c.launchCount()); } catch { console.log(`工厂 ${fa} 读不到 launchCount,跳过`); continue; }
  const idx = Array.from({ length: n }, (_, i) => i);
  const rows = await pool(idx, (i) => new ethers.Contract(fa, FACTORY_ABI, P()).launches(i));
  // 两个槽位都要看:LP 分红金库挂在 taxVault(小金鱼就是这样),不是 vault。只看 vault 会一个都筛不出来。
  for (const r of rows) if (r) { all.push({ token: r.token, vault: r.vault }); all.push({ token: r.token, vault: r.taxVault }); }
  console.log(`mint 工厂 ${fa}: ${n} 个发射`);
}
const CURVE_FACTORY_ABI = [
  "function launchCount() view returns (uint256)",
  "function launches(uint256) view returns (address)",
];
const TOKEN_VAULT_ABI = ["function vault() view returns (address)", "function taxVault() view returns (address)"];
for (const fa of CURVE_FACTORIES) {
  const c = new ethers.Contract(fa, CURVE_FACTORY_ABI, P());
  let n = 0;
  try { n = Number(await c.launchCount()); } catch { console.log(`曲线工厂 ${fa} 读不到 launchCount,跳过`); continue; }
  const idx = Array.from({ length: n }, (_, i) => i);
  const toks = await pool(idx, (i) => new ethers.Contract(fa, CURVE_FACTORY_ABI, P()).launches(i));
  const withVault = await pool(toks.filter(Boolean), async (t) => {
    try { return { token: t, vault: await new ethers.Contract(t, TOKEN_VAULT_ABI, P()).vault() }; } catch { return null; }
  });
  for (const r of withVault) if (r) all.push(r);
  console.log(`曲线工厂 ${fa}: ${n} 个发射`);
}
console.log(`\n共 ${all.length} 个发射,筛出「持有 LP 分红」金库…\n`);

// 2) 只留 LPHolder 金库(有 holderRewardCondition + lpToken 的才是)
const lpVaults = (await pool(all, async (x) => {
  if (!x.vault || x.vault === ethers.ZeroAddress) return null;
  const v = new ethers.Contract(x.vault, VAULT_ABI, P());
  try { await v.holderRewardCondition(); } catch { return null; }
  let lp; try { lp = await v.lpToken(); } catch { return null; }
  return { ...x, lp };
})).filter(Boolean);

console.log(`命中 ${lpVaults.length} 个 LP 分红金库\n`);
console.log("代币        覆盖率     可分配LP        已登记LP      漏登LP     人数   金库");
console.log("─".repeat(100));

let bad = 0;
for (const x of lpVaults) {
  const v = new ethers.Contract(x.vault, VAULT_ABI, P());
  let sym = "?";
  try { sym = await new ethers.Contract(x.token, ERC20, P()).symbol(); } catch {}
  let distLp, hc;
  try { const s = await v.getVaultStats(); hc = Number(s[0]); distLp = s[1]; } catch { console.log(`${sym.padEnd(11)} 读取失败`); continue; }
  if (distLp === 0n) { console.log(`${sym.padEnd(11)} 可分配 LP 为 0(未开盘/已撤池)`); continue; }
  const hs = (await v.getHolders(0, 500)).map((a) => a);
  const bals = await pool(hs, (a) => new ethers.Contract(x.lp, ERC20, P()).balanceOf(a));
  const sum = bals.reduce((a, b) => a + (b ?? 0n), 0n);
  const gap = distLp - sum;
  const cov = Number((sum * 10000n) / distLp) / 100;
  if (cov < 99.5) bad++;
  console.log(
    `${sym.padEnd(11)} ${(cov.toFixed(2) + "%").padStart(8)} ${f(distLp).toFixed(4).padStart(14)} ${f(sum).toFixed(4).padStart(14)} ${f(gap).toFixed(4).padStart(11)} ${String(hc).padStart(6)}   ${x.vault}`
  );
}
console.log("─".repeat(100));
console.log(`\n${lpVaults.length} 个 LP 分红金库中,${bad} 个覆盖率 < 99.5%(存在漏登)`);
