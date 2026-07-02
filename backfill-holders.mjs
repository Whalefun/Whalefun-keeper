// 一次性回补「持有 LP 分红金库」的持有人名单:
//   BscScan(Etherscan V2)API 拉 LP 全量 Transfer 事件 → 汇总候选地址 → 链上过滤 LP 余额>0
//   → 跳过已登记 → addHolders 批量录入(permissionless,任何钱包可发)。
// 用法:
//   ETHERSCAN_API_KEY=xxx PK=0x... node backfill-holders.mjs <vault>
//   可选 env:RPC_URL(默认 bsc-dataseed)、DRY_RUN=1(只打印不发交易)
import { ethers } from "ethers";

const vaultAddr = process.argv[2];
if (!vaultAddr) { console.error("用法: node backfill-holders.mjs <vault地址>"); process.exit(1); }
const KEY = process.env.ETHERSCAN_API_KEY;
if (!KEY) { console.error("缺 ETHERSCAN_API_KEY"); process.exit(1); }

const RPC = process.env.RPC_URL || "https://bsc-dataseed.bnbchain.org";
const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
const DEAD = "0x000000000000000000000000000000000000dead";
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

const VAULT_ABI = [
  "function lpToken() view returns (address)",
  "function holderCount() view returns (uint256)",
  "function getHolders(uint256,uint256) view returns (address[])",
  "function addHolders(address[])",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

const vault = new ethers.Contract(vaultAddr, VAULT_ABI, provider);
const lp = (await vault.lpToken()).toLowerCase();
console.log("vault  :", vaultAddr);
console.log("lpToken:", lp);

// 1) Etherscan V2 getLogs 分页拉全量 Transfer(免费档可用;每页 1000)
const cands = new Set();
for (let page = 1; page <= 50; page++) {
  const url = `https://api.etherscan.io/v2/api?chainid=56&module=logs&action=getLogs&address=${lp}` +
    `&topic0=${TRANSFER_TOPIC}&fromBlock=0&toBlock=latest&page=${page}&offset=1000&apikey=${KEY}`;
  const j = await (await fetch(url)).json();
  if (j.status !== "1" || !Array.isArray(j.result) || j.result.length === 0) {
    if (page === 1) console.log("etherscan 返回:", j.message ?? j.result);
    break;
  }
  for (const lg of j.result) {
    if (lg.topics?.length >= 3) {
      cands.add(("0x" + lg.topics[1].slice(26)).toLowerCase());
      cands.add(("0x" + lg.topics[2].slice(26)).toLowerCase());
    }
  }
  console.log(`第 ${page} 页:${j.result.length} 条日志,累计候选 ${cands.size} 个地址`);
  if (j.result.length < 1000) break;
  await new Promise((r) => setTimeout(r, 250)); // 免费档 5 req/s,留余量
}

// 2) 排除特殊地址 + 已登记
cands.delete(ethers.ZeroAddress.toLowerCase());
cands.delete(DEAD);
cands.delete(lp);
cands.delete(vaultAddr.toLowerCase());
const existing = new Set();
const hn = Number(await vault.holderCount());
for (let i = 0; i < hn; i += 200) {
  (await vault.getHolders(i, 200)).forEach((a) => existing.add(a.toLowerCase()));
}
console.log(`候选 ${cands.size} 个;已登记 ${existing.size} 个`);

// 3) 链上过滤:LP 余额 > 0 且未登记
const lpc = new ethers.Contract(lp, ERC20_ABI, provider);
const toAdd = [];
for (const a of cands) {
  if (existing.has(a)) continue;
  try { if ((await lpc.balanceOf(a)) > 0n) toAdd.push(a); } catch {}
}
console.log(`待录入(LP 余额>0 且未登记):${toAdd.length} 个`);
toAdd.forEach((a) => console.log("  +", a));

if (toAdd.length === 0) { console.log("无需录入,结束。"); process.exit(0); }
if (process.env.DRY_RUN) { console.log("DRY_RUN=1,不发交易。"); process.exit(0); }

// 4) addHolders 批量录入
const PK = process.env.PK;
if (!PK) { console.error("缺 PK(发交易的钱包私钥)"); process.exit(1); }
const wallet = new ethers.Wallet(PK, provider);
const vw = vault.connect(wallet);
for (let i = 0; i < toAdd.length; i += 100) {
  const slice = toAdd.slice(i, i + 100);
  const tx = await vw.addHolders(slice, { gasLimit: 4_000_000 });
  const rc = await tx.wait();
  console.log(`addHolders ${slice.length} 个 ✅ tx ${rc.hash}`);
}
console.log("登记后 holderCount:", (await vault.holderCount()).toString());
