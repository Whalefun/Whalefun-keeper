// 扫全平台 v2 代币,判定"回购为何近期没触发":对每个已开盘且底池不枯的币,读
//   累积税 balanceOf(self) / liquidationThreshold(≥1 才会在下次卖出触发 swapTokenForFund→买烧$WHALE)
//   + pendingWhaleBNB(>0 = 触发过但买$WHALE失败在排队重试)。
// 用法:  node scan-buyback-state.mjs   (默认 dataseed,当前态读取,无需归档/getLogs)
import { ethers } from "ethers";

const RPC = process.env.RPC_URL || "https://bsc-dataseed.bnbchain.org";
const p = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const FACTORIES = [
  "0x1230B67525247DA20e56E9f8CAaA263ae670401a",
  "0xaDeb3eaEbA2fE20Afdb20529382e4395FaA2821c",
  "0x2196D9B1Ee3411a4C6E26a417861713151EcdC07",
  "0xB5AF6387ed653F3f15C01Da4031571Fd454DF22f",
];
const FAC_ABI = ["function launchCount() view returns (uint256)", "function launches(uint256) view returns (address token, address vault, address taxVault, address pair, address creator)"];
const TOK_ABI = [
  "function symbol() view returns (string)",
  "function startTradeBlock() view returns (uint256)",
  "function liquidationThreshold() view returns (uint256)",
  "function pendingWhaleBNB() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function pair() view returns (address)",
];
const PAIR_ABI = ["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)"];
const f = (x) => Number(ethers.formatEther(x));

const seen = new Set();
let alive = 0, armed = 0, pendingStuck = 0, totalPending = 0n;
const rows = [];
for (const fa of FACTORIES) {
  const fc = new ethers.Contract(fa, FAC_ABI, p);
  let n; try { n = Number(await fc.launchCount()); } catch { continue; }
  for (let i = 0; i < n; i++) {
    let info; try { info = await fc.launches(i); } catch { continue; }
    const t = String(info.token).toLowerCase();
    if (seen.has(t)) continue; seen.add(t);
    const tok = new ethers.Contract(info.token, TOK_ABI, p);
    try {
      if ((await tok.startTradeBlock()) === 0n) continue; // 内盘未开盘
      const pair = new ethers.Contract(info.pair, PAIR_ABI, p);
      const [r, t0] = await Promise.all([pair.getReserves(), pair.token0()]);
      const wbnb = String(t0).toLowerCase() === WBNB.toLowerCase() ? r[0] : r[1];
      if (wbnb < ethers.parseEther("0.3")) continue; // 死币跳过
      alive++;
      const [sym, thr, pend, accum] = await Promise.all([
        tok.symbol().catch(() => "?"), tok.liquidationThreshold(), tok.pendingWhaleBNB(), tok.balanceOf(info.token),
      ]);
      const ratio = thr > 0n ? f(accum) / f(thr) : 0;
      if (accum >= thr && thr > 0n) armed++;
      if (pend > 0n) { pendingStuck++; totalPending += pend; }
      rows.push({ sym, token: info.token, poolBnb: f(wbnb), ratio, pend: f(pend) });
    } catch {}
  }
}
rows.sort((a, b) => b.ratio - a.ratio);
console.log(`存活币 ${alive} 个 · 已到阈值(下次卖出即触发回购)${armed} 个 · pendingWhaleBNB 卡住 ${pendingStuck} 个(共 ${f(totalPending).toFixed(6)} BNB)\n`);
console.log("按 累积税/阈值 比例 降序(Top 20):");
console.log("symbol           池BNB    积税/阈值    pendingWhaleBNB");
for (const r of rows.slice(0, 20)) {
  console.log(`${(r.sym||"?").padEnd(14)} ${r.poolBnb.toFixed(2).padStart(8)}  ${(r.ratio*100).toFixed(1).padStart(7)}%   ${r.pend > 0 ? r.pend.toFixed(6)+" ⚠️" : "-"}`);
}
