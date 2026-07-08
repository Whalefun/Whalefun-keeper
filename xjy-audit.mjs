// 小金鱼 LP 分红金库 —— 一键对账:金库登记名单 里【LP 已清零】的(占名额没意义)+
// 打印当前名单供人工比对 BscScan 真实持有人。
// 用法:node xjy-audit.mjs
//   补漏:node xjy-audit.mjs 0xNEW1 0xNEW2 ...   (仅打印待补的模拟结果,不广播)
//   真补:BROADCAST=1 node xjy-audit.mjs 0xNEW1 0xNEW2 ...   (用 Mint发射台-合约/.env 的 PRIVATE_KEY 广播 addHolders)
//
// 反查"有没有漏登"这一步需要 LP 全体持有人列表 —— 免费 getLogs 生态(Alchemy 超载 / Etherscan 封 BSC)
// 都不可用,所以人工去 BscScan 看:
//   https://bscscan.com/token/0xf7f4f69a65876b05aefadd4903a69ba1e0eb5dee#balances
//   把那里【余额>0、且不是 DEAD/Null/PancakeSwap Fee 地址】的地址,与本脚本打印的"已登记名单"比对,
//   缺的就是漏登 → 传给本脚本补上。
import { readFileSync } from "fs";
import { ethers } from "ethers";

const VAULT = "0x69EAd3E6387EEb1C4A8A84B3A3C9441A89e4A867"; // 小金鱼 LPHolder 金库
const LP = "0xf7f4f69a65876b05aefadd4903a69ba1e0eb5dee";
const RPC = process.env.RPC_URL || "https://bsc-dataseed.bnbchain.org";
const toAdd = process.argv.slice(2).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));

const p = new ethers.JsonRpcProvider(RPC);
const vault = new ethers.Contract(VAULT, [
  "function holderCount() view returns (uint256)",
  "function getHolders(uint256,uint256) view returns (address[])",
  "function addHolders(address[] accounts)",
], p);
const lp = new ethers.Contract(LP, ["function balanceOf(address) view returns (uint256)"], p);

const cnt = Number(await vault.holderCount());
const hs = await vault.getHolders(0, 200);
console.log(`=== 金库登记名单 holderCount=${cnt} ===`);
let zero = 0;
for (const h of hs) {
  const b = await lp.balanceOf(h);
  const z = b === 0n;
  if (z) zero++;
  console.log(`${z ? "⚠️ " : "   "}${h}  LP=${ethers.formatEther(b)}${z ? "  (已清零,派发时会被自动清出)" : ""}`);
}
console.log(`\n名单 ${hs.length} 个,其中 LP=0 的 ${zero} 个(无需处理,合约派发时自动移除)`);
console.log(`\n👉 反查漏登:打开 https://bscscan.com/token/${LP}#balances`);
console.log(`   把余额>0 且非 DEAD/Null/PancakeSwap-Fee 的地址,与上面名单比对,缺的用:`);
console.log(`   BROADCAST=1 node xjy-audit.mjs <漏登地址...>\n`);

if (toAdd.length === 0) process.exit(0);

const reg = new Set(hs.map((x) => x.toLowerCase()));
const fresh = toAdd.filter((a) => !reg.has(a.toLowerCase()));
console.log(`=== 待补 ${toAdd.length} 个,其中未登记 ${fresh.length} 个 ===`);
for (const a of toAdd) console.log(`  ${a}  LP=${ethers.formatEther(await lp.balanceOf(a))}  ${reg.has(a.toLowerCase()) ? "(已在名单,跳过)" : "→ 待补"}`);
if (fresh.length === 0) { console.log("无新增需补。"); process.exit(0); }

if (process.env.BROADCAST !== "1") {
  console.log("\n(未广播 —— 加 BROADCAST=1 环境变量才真正发交易)");
  process.exit(0);
}

const env = readFileSync("C:/Users/ASUS/Desktop/Mint发射台-合约/.env", "utf8");
const m = env.match(/^\s*PRIVATE_KEY\s*=\s*((0x)?[0-9a-fA-F]{64})\s*$/m);
if (!m) { console.error("没找到 PRIVATE_KEY"); process.exit(1); }
const wallet = new ethers.Wallet(m[1].startsWith("0x") ? m[1] : "0x" + m[1], p);
const vw = vault.connect(wallet);
console.log(`\n签名钱包 ${wallet.address}  BNB=${ethers.formatEther(await p.getBalance(wallet.address))}`);
await vw.addHolders.staticCall(fresh);
const tx = await vw.addHolders(fresh);
console.log("tx:", tx.hash);
const rc = await tx.wait();
console.log("状态:", rc.status === 1 ? "✅ 成功" : "❌ 失败", " holderCount:", (await vault.holderCount()).toString());
