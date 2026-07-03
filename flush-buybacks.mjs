// 对全平台 v2 代币逐个调 flushBuybacks():把每个币攒着的 pendingWhaleBNB(无视 0.02 门槛)
// 立即买 $WHALE 烧进 0xdEaD。排除「小金鱼」(用户要它继续攒)。permissionless,任意钱包发,只花 gas。
// 用法:  DRY_RUN=1 node flush-buybacks.mjs        # 只列不发
//        PK=0x... node flush-buybacks.mjs          # 实发
import { ethers } from "ethers";

const RPC = process.env.RPC_URL || "https://bsc-dataseed.bnbchain.org";
const p = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
const WHALE = "0x714347aE1d0a130Dbc6Ea75c7caC132f4e8aAAaA";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const SKIP_SYMBOL = "小金鱼";
const MIN_FLUSH = ethers.parseEther(process.env.MIN_FLUSH || "0.0005"); // 低于此不值一笔 gas,跳过
const FACTORIES = [
  "0x1230B67525247DA20e56E9f8CAaA263ae670401a",
  "0xaDeb3eaEbA2fE20Afdb20529382e4395FaA2821c",
  "0x2196D9B1Ee3411a4C6E26a417861713151EcdC07",
  "0xB5AF6387ed653F3f15C01Da4031571Fd454DF22f",
];
const FAC_ABI = ["function launchCount() view returns (uint256)", "function launches(uint256) view returns (address token, address vault, address taxVault, address pair, address creator)"];
const TOK_ABI = ["function symbol() view returns (string)", "function pendingWhaleBNB() view returns (uint256)", "function flushBuybacks()"];
const WHALE_ABI = ["function balanceOf(address) view returns (uint256)"];
const f = (x) => Number(ethers.formatEther(x));

const whale = new ethers.Contract(WHALE, WHALE_ABI, p);
const burnedBefore = await whale.balanceOf(DEAD);
console.log(`起始 0xdEaD 的 $WHALE: ${f(burnedBefore).toLocaleString()}\n`);

const seen = new Set();
const targets = [];
for (const fa of FACTORIES) {
  const fc = new ethers.Contract(fa, FAC_ABI, p);
  let n; try { n = Number(await fc.launchCount()); } catch { continue; }
  for (let i = 0; i < n; i++) {
    let info; try { info = await fc.launches(i); } catch { continue; }
    const t = String(info.token).toLowerCase();
    if (seen.has(t)) continue; seen.add(t);
    const tok = new ethers.Contract(info.token, TOK_ABI, p);
    try {
      const [pend, sym] = await Promise.all([tok.pendingWhaleBNB().catch(() => 0n), tok.symbol().catch(() => "?")]);
      if (pend === 0n) continue;
      if (sym === SKIP_SYMBOL) { console.log(`跳过 ${sym} (${info.token}) pending=${f(pend)} —— 按要求保留`); continue; }
      if (pend < MIN_FLUSH) { console.log(`跳过尘埃 ${sym} pending=${f(pend)} < ${f(MIN_FLUSH)}(gas 比它还贵,留着以后自然攒/keeper 冲)`); continue; }
      targets.push({ token: info.token, sym, pend });
    } catch {}
  }
}

const totalPend = targets.reduce((s, x) => s + x.pend, 0n);
console.log(`\n待 flush ${targets.length} 个币,合计 pending ${f(totalPend).toFixed(5)} BNB → 将全部买 $WHALE 烧毁:`);
for (const t of targets) console.log(`  ${(t.sym || "?").padEnd(14)} pending=${f(t.pend).toFixed(5)} BNB  ${t.token}`);

if (process.env.DRY_RUN) { console.log("\nDRY_RUN=1,不发交易。"); process.exit(0); }
const PK = process.env.PK;
if (!PK) { console.error("\n缺 PK(发交易的钱包私钥)"); process.exit(1); }
const wallet = new ethers.Wallet(PK, p);
console.log(`\n发送钱包 ${wallet.address},逐个 flushBuybacks…\n`);
let ok = 0, fail = 0;
for (const t of targets) {
  const c = new ethers.Contract(t.token, TOK_ABI, wallet);
  try {
    const rc = await (await c.flushBuybacks({ gasLimit: 2000000, gasPrice: ethers.parseUnits("1", "gwei") })).wait();
    console.log(`  ✅ ${t.sym.padEnd(14)} flush ${f(t.pend).toFixed(5)} BNB → tx ${rc.hash}`);
    ok++;
  } catch (e) {
    console.log(`  ❌ ${t.sym.padEnd(14)} 失败:${e.shortMessage || e.message}`);
    fail++;
  }
}
const burnedAfter = await whale.balanceOf(DEAD);
console.log(`\n完成:成功 ${ok} / 失败 ${fail}`);
console.log(`本次新烧 $WHALE: ${f(burnedAfter - burnedBefore).toLocaleString(undefined,{maximumFractionDigits:2})}  (dead: ${f(burnedBefore).toFixed(0)} → ${f(burnedAfter).toFixed(0)})`);
