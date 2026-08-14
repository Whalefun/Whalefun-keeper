// 把 find-missing.mjs 找出的漏登地址补进金库的持有人名单。
//
// addHolders 是 permissionless 的,签名钱包只出 gas、不需要任何权限(不是 owner/guardian)。
// 广播前逐个复核:LP 余额仍 > 0、且确实不在名单里 —— 名单是会变的(用户可能自己点过「登记领分红」)。
//
// 用法:
//   node backfill-missing.mjs <vault> <名单json>              干跑
//   BROADCAST=1 node backfill-missing.mjs <vault> <名单json>  真发
// 私钥从 Mint发射台-合约/.env 读,默认用 KEEPER_PK(无权限热钱包);PK_KEY=PRIVATE_KEY 可换。
import { ethers } from "ethers";
import { readFileSync } from "fs";

const VAULT = process.argv[2] || "0x69EAd3E6387EEb1C4A8A84B3A3C9441A89e4A867";
const LIST = process.argv[3] || "./xjy-missing-merged.json";
const PK_KEY = process.env.PK_KEY || "KEEPER_PK";

const p = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://bsc-dataseed.bnbchain.org", undefined, { batchMaxCount: 1 });
const VAULT_ABI = [
  "function lpToken() view returns (address)",
  "function getVaultStats() view returns (uint256,uint256,uint256,uint256,uint256)",
  "function getHolders(uint256,uint256) view returns (address[])",
  "function addHolders(address[])",
];
const vault = new ethers.Contract(VAULT, VAULT_ABI, p);
const lpAddr = await vault.lpToken();
const lp = new ethers.Contract(lpAddr, ["function balanceOf(address) view returns (uint256)"], p);
const f = (x) => ethers.formatEther(x);
// 重试到底:一次读失败被当成 0 会让地址被误判为"已清仓",直接漏补
const bal = async (a) => { for (let i = 0; ; i++) { try { return await lp.balanceOf(a); } catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 400 * (i + 1))); } } };

const wanted = JSON.parse(readFileSync(LIST, "utf8")).map((x) => x.addr.toLowerCase());
const registered = new Set((await vault.getHolders(0, 500)).map((a) => a.toLowerCase()));

const toAdd = [];
console.log(`名单 ${wanted.length} 个,逐个复核:`);
for (const a of wanted) {
  const b = await bal(a);
  if (registered.has(a)) { console.log(`  跳过 ${a}  已在名单里`); continue; }
  if (b === 0n) { console.log(`  跳过 ${a}  LP 已清零`); continue; }
  toAdd.push(a);
  console.log(`  补登 ${a}  LP=${f(b)}`);
}
if (!toAdd.length) { console.log("\n没有需要补登的,结束。"); process.exit(0); }

const [, distLpBefore] = await vault.getVaultStats();
let addSum = 0n; for (const a of toAdd) addSum += await bal(a);
console.log(`\n待补 ${toAdd.length} 个,合计 ${f(addSum)} LP,占可分配 LP 的 ${(Number((addSum * 10000n) / distLpBefore) / 100).toFixed(2)}%`);

const env = readFileSync("C:/Users/ASUS/Desktop/Mint发射台-合约/.env", "utf8");
const m = env.match(new RegExp(`^\\s*${PK_KEY}\\s*=\\s*"?((0x)?[0-9a-fA-F]{64})"?\\s*$`, "m"));
if (!m) { console.error(`.env 里没找到 ${PK_KEY}`); process.exit(1); }
const wallet = new ethers.Wallet(m[1].startsWith("0x") ? m[1] : "0x" + m[1], p);
console.log(`签名钱包 (${PK_KEY}) ${wallet.address}  BNB=${f(await p.getBalance(wallet.address))}`);

const vw = vault.connect(wallet);
await vw.addHolders.staticCall(toAdd);           // 先模拟,revert 就别发
const est = await vw.addHolders.estimateGas(toAdd);
const fee = (await p.getFeeData()).gasPrice ?? 0n;
console.log(`模拟通过 ✅  预估 gas ${est}  gasPrice ${ethers.formatUnits(fee, "gwei")} gwei  ≈ ${f(est * fee)} BNB`);

if (process.env.BROADCAST !== "1") { console.log("\n干跑结束 —— 加 BROADCAST=1 才真发。"); process.exit(0); }

const tx = await vw.addHolders(toAdd, { gasLimit: (est * 15n) / 10n });
console.log(`\n已广播 ${tx.hash},等确认…`);
const rc = await tx.wait();
console.log(`${rc.status === 1 ? "✅ 成功" : "❌ 失败"}  区块 ${rc.blockNumber}  实际 gas ${rc.gasUsed}`);

const [hc, distLp] = await vault.getVaultStats();
const hs = await vault.getHolders(0, 500);
let sum = 0n; for (const h of hs) sum += await bal(h);
console.log(`\n补登后:${hc} 人,已登记 LP ${f(sum)} / 可分配 ${f(distLp)} = 覆盖率 ${(Number((sum * 10000n) / distLp) / 100).toFixed(2)}%`);
console.log(`剩余缺口 ${f(distLp - sum)} LP`);
