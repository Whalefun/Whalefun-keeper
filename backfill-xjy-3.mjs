// 一次性回补:把 3 个漏网的小金鱼 LP 持有人 addHolders 进「持有 LP 分红」金库。
// addHolders 是 permissionless(合约内部校验 LP 余额>0 才真正登记),签名钱包只出 gas。
// key 从 Mint发射台-合约/.env 的 PRIVATE_KEY 读,不回显。
import { readFileSync } from "fs";
import { ethers } from "ethers";

const VAULT = "0x69EAd3E6387EEb1C4A8A84B3A3C9441A89e4A867"; // 小金鱼 LPHolder 金库
const MISSING = [
  "0x7a17fa4b8d3b37a646ef631e8be630c087777777",
  "0x33bdbb87f7a14f780abc303a68b6eb4c2d333333",
  "0xe9f786f9c35cb172953f7746719385d539999999",
];

const env = readFileSync("C:/Users/ASUS/Desktop/Mint发射台-合约/.env", "utf8");
const m = env.match(/^\s*PRIVATE_KEY\s*=\s*((0x)?[0-9a-fA-F]{64})\s*$/m);
if (!m) { console.error("没找到 PRIVATE_KEY"); process.exit(1); }
const pk = m[1].startsWith("0x") ? m[1] : "0x" + m[1];

const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.bnbchain.org");
const wallet = new ethers.Wallet(pk, provider);
const vault = new ethers.Contract(VAULT, [
  "function addHolders(address[] accounts)",
  "function holderCount() view returns (uint256)",
  "function getHolders(uint256,uint256) view returns (address[])",
], wallet);

console.log("签名钱包:", wallet.address, " BNB:", ethers.formatEther(await provider.getBalance(wallet.address)));
console.log("回补前 holderCount:", (await vault.holderCount()).toString());

// 先模拟,确认不 revert 再广播
await vault.addHolders.staticCall(MISSING);
console.log("模拟通过 → 广播…");
const tx = await vault.addHolders(MISSING);
console.log("tx:", tx.hash);
const rc = await tx.wait();
console.log("状态:", rc.status === 1 ? "✅ 成功" : "❌ 失败", " gas 用量:", rc.gasUsed.toString());

console.log("回补后 holderCount:", (await vault.holderCount()).toString());
const hs = await vault.getHolders(0, 50);
for (const a of MISSING) {
  console.log(" ", a, hs.map(x => x.toLowerCase()).includes(a.toLowerCase()) ? "✅ 已登记" : "❌ 仍未登记");
}
