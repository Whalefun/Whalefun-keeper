// Whale.fun 分红 keeper —— 遍历平台所有 v2 代币,把累积的可领分红批量推给持有人。
// 设计:permissionless 调用(distributeTo),热钱包只付 gas、无任何权限;漏跑只是延迟,用户随时可自领。
//
// 运行:  node keeper/dividend-keeper.mjs            (跑一轮就退出 —— 适合 cron / serverless)
//        LOOP=1 node keeper/dividend-keeper.mjs      (常驻循环 —— 适合 VPS + pm2)
//
// 需要 ethers v6:  npm i ethers
// 环境变量(见 keeper/README.md):
//   RPC_URL              BSC RPC(主网 https://bsc-rpc.publicnode.com)
//   KEEPER_PK            热钱包私钥(只放少量 BNB 付 gas;绝不用 owner/部署/guardian 私钥)
//   LAUNCH_FACTORY_V2    v2 工厂地址
//   MIN_OWED_WEI         单个持有人可领低于此值则跳过(默认 1e14 = 0.0001,省 gas)
//   BATCH                每笔 distributeTo 的地址数(默认 100)
//   INTERVAL_MS          LOOP 模式下每轮间隔(默认 300000 = 5min)

import { ethers } from "ethers";

const RPC = process.env.RPC_URL || "https://bsc-rpc.publicnode.com";
const PK = process.env.KEEPER_PK;
const FACTORY = process.env.LAUNCH_FACTORY_V2;
const MIN_OWED = BigInt(process.env.MIN_OWED_WEI || "100000000000000"); // 1e14
const BATCH = Number(process.env.BATCH || "100");
const INTERVAL_MS = Number(process.env.INTERVAL_MS || "300000");

if (!PK || !FACTORY) {
  console.error("缺少 KEEPER_PK 或 LAUNCH_FACTORY_V2 环境变量");
  process.exit(1);
}

const FACTORY_ABI = [
  "function launchCount() view returns (uint256)",
  "function launches(uint256) view returns (address token,address vault,address taxVault,address pair,address creator,uint256 createdAt)",
];
const TOKEN_ABI = [
  "function startTradeBlock() view returns (uint256)",
  "function holderCount() view returns (uint256)",
  "function holderAt(uint256) view returns (address)",
  "function withdrawableDividendOf(address) view returns (uint256)",
  "function distributeTo(address[]) returns (uint256)",
];
// DWC「分红任意代币金库」专用(其它金库没有这些方法 → 调用 revert,被 try/catch 跳过)
const VAULT_ABI = [
  "function snowball()",                                  // permissionless:触发本轮派发(买分红币+回购销毁)
  "function syncPlatformDividend()",                      // permissionless:冷启动同步 totalShares oracle
  "function totalShares() view returns (uint256)",
  "function secondsUntilNextSnowball() view returns (uint256)",
  "function dividendBudget() view returns (uint256)",
  "function buybackBudget() view returns (uint256)",
];
const PER_LEG = BigInt(process.env.VAULT_PER_LEG_WEI || "10000000000000000"); // 0.01 BNB(每池满才派发)

const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
const wallet = new ethers.Wallet(PK, provider);

async function processToken(tokenAddr) {
  const token = new ethers.Contract(tokenAddr, TOKEN_ABI, wallet);
  if ((await token.startTradeBlock()) === 0n) return; // 未开盘,无分红

  const n = Number(await token.holderCount());
  if (n === 0) return;

  // 读所有持有人 → 算谁欠分红(分块并发读,避免一次过载 RPC)
  const owed = [];
  for (let i = 0; i < n; i += 50) {
    const idxs = Array.from({ length: Math.min(50, n - i) }, (_, k) => i + k);
    const addrs = await Promise.all(idxs.map((j) => token.holderAt(j)));
    const amts = await Promise.all(addrs.map((a) => token.withdrawableDividendOf(a)));
    addrs.forEach((a, k) => { if (amts[k] >= MIN_OWED) owed.push(a); });
  }
  if (owed.length === 0) return;

  // 分批 distributeTo
  for (let i = 0; i < owed.length; i += BATCH) {
    const slice = owed.slice(i, i + BATCH);
    try {
      const tx = await token.distributeTo(slice);
      const rc = await tx.wait();
      console.log(`[${tokenAddr}] distributeTo ${slice.length} 个 → tx ${rc.hash}`);
    } catch (e) {
      console.error(`[${tokenAddr}] distributeTo 失败:`, e.shortMessage || e.message);
    }
  }
}

// 金库(DWC「分红任意代币金库」):冷启动同步 oracle + 够一轮就触发派发。
// snowball/syncPlatformDividend 现已 permissionless,keeper 热钱包无需任何角色。
async function processVault(vaultAddr) {
  if (!vaultAddr || vaultAddr === ethers.ZeroAddress) return;
  const vault = new ethers.Contract(vaultAddr, VAULT_ABI, wallet);
  // 1. 冷启动:totalShares=0(oracle 未同步)时同步一次
  try {
    if ((await vault.totalShares()) === 0n) {
      const rc = await (await vault.syncPlatformDividend()).wait();
      console.log(`[vault ${vaultAddr}] syncPlatformDividend → tx ${rc.hash}`);
    }
  } catch { /* 非 DWC 金库 / 无此方法 → 跳过 */ }
  // 2. 轮次到 + 任一池满 perLeg 才触发(省 gas,避免空跑)
  try {
    const [secs, divB, buyB] = await Promise.all([
      vault.secondsUntilNextSnowball(),
      vault.dividendBudget(),
      vault.buybackBudget(),
    ]);
    if (secs === 0n && (divB >= PER_LEG || buyB >= PER_LEG)) {
      // 显式高 gas:分红腿买 FLAP 税费代币单条 ~282k,两条腿 + 开销留足余量。
      // 不靠自动估算(合约虽加了 gas 地板修正估算,这里再兜底一层)。
      const rc = await (await vault.snowball({ gasLimit: 900000 })).wait();
      console.log(`[vault ${vaultAddr}] snowball → tx ${rc.hash}`);
    }
  } catch (e) { /* 非 DWC 金库 / 无此方法 → 跳过 */ void e; }
}

async function runOnce() {
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  const count = Number(await factory.launchCount());
  console.log(`扫描 ${count} 个 v2 代币 · keeper ${wallet.address}`);
  for (let i = 0; i < count; i++) {
    try {
      const info = await factory.launches(i);
      await processToken(info.token);
      await processVault(info.vault); // 金库分红:同步 oracle + 触发 snowball
    } catch (e) {
      console.error(`launch #${i} 处理出错:`, e.shortMessage || e.message);
    }
  }
  console.log("本轮完成");
}

async function main() {
  if (process.env.LOOP === "1") {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await runOnce().catch((e) => console.error("轮次异常:", e.message));
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  } else {
    await runOnce();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
