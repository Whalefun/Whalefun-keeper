// 扫全平台 v2 代币,汇总"沉淀在 token 合约里的价值":
//   ① 合约 BNB 余额(基本=pendingWhaleBNB,回购未到门槛的钱)
//   ② 未清算税代币 balanceOf(self),按当前池价折成 BNB(死币池≈0,乐观上限)
// 按 存活/死币 分类汇总。纯读链,不动任何状态。
// 用法:  node scan-stranded.mjs   (默认 dataseed)
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
  "function decimals() view returns (uint8)",
  "function startTradeBlock() view returns (uint256)",
  "function pendingWhaleBNB() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const PAIR_ABI = ["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)"];
const f = (x) => Number(ethers.formatEther(x));
const ALIVE_MIN = ethers.parseEther("0.3");

const seen = new Set();
let nLaunched = 0, nAlive = 0, nDead = 0;
let bnbAlive = 0, bnbDead = 0, pendAlive = 0, pendDead = 0, taxValAlive = 0, taxValDead = 0;
const dead = [];

for (const fa of FACTORIES) {
  const fc = new ethers.Contract(fa, FAC_ABI, p);
  let n; try { n = Number(await fc.launchCount()); } catch { continue; }
  for (let i = 0; i < n; i++) {
    let info; try { info = await fc.launches(i); } catch { continue; }
    const t = String(info.token).toLowerCase();
    if (seen.has(t)) continue; seen.add(t);
    const tok = new ethers.Contract(info.token, TOK_ABI, p);
    try {
      if ((await tok.startTradeBlock()) === 0n) continue; // 内盘未开盘,无沉淀
      nLaunched++;
      const [bal, pend, taxTok, sym] = await Promise.all([
        p.getBalance(info.token), tok.pendingWhaleBNB().catch(() => 0n), tok.balanceOf(info.token), tok.symbol().catch(() => "?"),
      ]);
      // 池价:税代币折 BNB
      let priceBnbPerTok = 0, wbnbRes = 0n;
      try {
        const pair = new ethers.Contract(info.pair, PAIR_ABI, p);
        const [r, t0] = await Promise.all([pair.getReserves(), pair.token0()]);
        const isT0W = String(t0).toLowerCase() === WBNB.toLowerCase();
        wbnbRes = isT0W ? r[0] : r[1];
        const tokRes = isT0W ? r[1] : r[0];
        if (tokRes > 0n) priceBnbPerTok = f(wbnbRes) / f(tokRes);
      } catch {}
      const taxVal = f(taxTok) * priceBnbPerTok;
      const isAlive = wbnbRes >= ALIVE_MIN;
      if (isAlive) { nAlive++; bnbAlive += f(bal); pendAlive += f(pend); taxValAlive += taxVal; }
      else { nDead++; bnbDead += f(bal); pendDead += f(pend); taxValDead += taxVal;
        if (f(bal) > 0.0005 || taxVal > 0.0005) dead.push({ sym, token: info.token, bnb: f(bal), taxVal }); }
    } catch {}
  }
}

console.log(`已开盘代币 ${nLaunched} 个 = 存活 ${nAlive} + 死币 ${nDead}(死币 = 底池 WBNB < 0.3）\n`);
console.log("沉淀在 token 合约里的价值(BNB 计):");
console.log(`                合约BNB余额    其中pendingWhaleBNB    未清算税代币折价`);
console.log(`  存活币   ${bnbAlive.toFixed(4).padStart(10)}     ${pendAlive.toFixed(4).padStart(10)}          ${taxValAlive.toFixed(4).padStart(8)}`);
console.log(`  死  币   ${bnbDead.toFixed(4).padStart(10)}     ${pendDead.toFixed(4).padStart(10)}          ${taxValDead.toFixed(4).padStart(8)}`);
console.log(`  合  计   ${(bnbAlive+bnbDead).toFixed(4).padStart(10)}     ${(pendAlive+pendDead).toFixed(4).padStart(10)}          ${(taxValAlive+taxValDead).toFixed(4).padStart(8)}`);
console.log(`\n注:合约BNB余额基本=pendingWhaleBNB(回购未到0.02门槛的钱);税代币折价=池价现值(死币池薄,实际卖出远拿不到、多半卖不动)。`);
console.log(`\n死币中有余额的(BNB余额>0.0005 或 税代币值>0.0005):`);
dead.sort((a,b)=>(b.bnb+b.taxVal)-(a.bnb+a.taxVal));
for (const d of dead.slice(0, 25)) console.log(`  ${(d.sym||"?").padEnd(14)} BNB=${d.bnb.toFixed(5)}  税代币值≈${d.taxVal.toFixed(5)}  ${d.token}`);
