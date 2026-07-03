// 验证平台币 $WHALE 回购销毁是否近期在执行:用归档节点(Alchemy)读销毁地址 0xdEaD 的
// $WHALE 余额在 now / 1h前 / 1天前 / 7天前 的快照,算出各时间窗销毁增量。
// 回购是交易/清算驱动的自动行为(每个币 swapTokenForFund 里买 $WHALE 打进 dead)。
// 用法:  node check-buyback.mjs https://bnb-mainnet.g.alchemy.com/v2/<你的key>
import { ethers } from "ethers";

const url = process.argv[2];
if (!url) { console.error("用法: node check-buyback.mjs <Alchemy_BSC_URL>"); process.exit(1); }
const p = new ethers.JsonRpcProvider(url, undefined, { batchMaxCount: 1 });

const WHALE = "0x714347aE1d0a130Dbc6Ea75c7caC132f4e8aAAaA";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const erc20 = new ethers.Contract(WHALE, [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
], p);

const latest = await p.getBlockNumber();
const supply = await erc20.totalSupply();
const f = (x) => Number(ethers.formatEther(x));

// BSC ~3s/块:1h≈1200、1天≈28800、7天≈201600
const points = [
  ["现在", latest],
  ["1 小时前", latest - 1200],
  ["1 天前", latest - 28800],
  ["7 天前", latest - 201600],
];

console.log(`$WHALE 销毁验证 · latest block ${latest} · 总量 ${f(supply).toLocaleString()}\n`);
const bal = {};
for (const [label, blk] of points) {
  try {
    const b = await erc20.balanceOf(DEAD, { blockTag: blk });
    bal[label] = b;
    console.log(`${label.padEnd(8)} (block ${blk}): 已销毁 ${f(b).toLocaleString(undefined,{maximumFractionDigits:2})} WHALE  (${(f(b)/f(supply)*100).toFixed(4)}% 总量)`);
  } catch (e) {
    console.log(`${label.padEnd(8)} (block ${blk}): 读取失败 → ${e.shortMessage || e.message}`);
  }
}

console.log("\n各时间窗销毁增量(>0 = 回购在跑):");
const now = bal["现在"];
for (const w of ["1 小时前", "1 天前", "7 天前"]) {
  if (bal[w] !== undefined && now !== undefined) {
    const d = f(now - bal[w]);
    console.log(`  最近${w.replace("前","").trim()}: +${d.toLocaleString(undefined,{maximumFractionDigits:2})} WHALE 销毁 ${d > 0 ? "✅" : "⚠️ 无增量"}`);
  }
}
