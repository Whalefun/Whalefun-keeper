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
// 私钥归一化:带不带 0x 前缀都能用(去空格、缺 0x 自动补)。
const PK = (() => { const k = (process.env.KEEPER_PK || "").trim(); return k ? (k.startsWith("0x") ? k : "0x" + k) : k; })();
// 可配多个工厂(升级后新+旧并存,逗号/空格分隔)。旧 v2 币的分红金库在旧工厂,必须一起扫,否则停发。
const FACTORIES = (process.env.LAUNCH_FACTORY_V2 || "")
  .split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
// 跳过名单:死币/废弃币的【代币地址】,逗号分隔。在仓库 Variables 里配 SKIP_TOKENS,改名单不用动代码。
const SKIP = new Set(
  (process.env.SKIP_TOKENS || "").split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
);
// 死币判定:底池 WBNB 低于此值就跳过(代币已崩、池子枯竭,再 snowball 只会把金库 BNB 砸进死池,纯浪费)。
// 默认 2 BNB,可用仓库 Variable MIN_POOL_BNB 调(填 BNB 数,如 "1.5")。
const MIN_POOL_BNB = (() => { try { return ethers.parseEther(String(process.env.MIN_POOL_BNB || "2")); } catch { return ethers.parseEther("2"); } })();
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const PAIR_ABI = [
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
];
const MIN_OWED = BigInt(process.env.MIN_OWED_WEI || "100000000000000"); // 1e14
const BATCH = Number(process.env.BATCH || "100");
const INTERVAL_MS = Number(process.env.INTERVAL_MS || "300000");

if (!PK || FACTORIES.length === 0) {
  console.error("缺少 KEEPER_PK 或 LAUNCH_FACTORY_V2 环境变量(后者可填多个,逗号分隔)");
  process.exit(1);
}

const FACTORY_ABI = [
  "function launchCount() view returns (uint256)",
  "function launches(uint256) view returns (address token,address vault,address taxVault,address pair,address creator,uint256 createdAt)",
];
const TOKEN_ABI = [
  "function startTradeBlock() view returns (uint256)",
  "function bucketDividendBps() view returns (uint16)",
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

// LP 质押分红金库专用(其它金库没有这些方法 → revert → try/catch 跳过)。keeper 只做"跨档升级 poke"。
const LP_VAULT_ABI = [
  "function stakerCount() view returns (uint256)",
  "function getStakers(uint256,uint256) view returns (address[])",
  "function userInfo(address) view returns (uint256 amount,uint256 effShare,uint256 rewardDebt,uint256 stakeStart)",
  "function pokeMany(address[])",
];
// 储备代币托底(Floor)金库专用。floor() 赎回不会自动买储备币,只有 buyPendingReserve() 会把
// 积累的税费 BNB 换成储备币、推高底价 → 必须 keeper 周期驱动,否则底池永远不积累。
// vaultStatus() 作类型探针:非 Floor 金库无此方法 → revert → 静默跳过。
const FLOOR_VAULT_ABI = [
  "function vaultStatus() view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
  "function buyPendingReserve()",
];
// 合约里的时间档(秒 → 总有效倍率 bps),keeper 用来判断谁跨档了、只 poke 需要的人,省 gas。
function multBps(durSec) {
  if (durSec < 3 * 3600) return 10000n;
  if (durSec < 7 * 3600) return 13000n;
  if (durSec < 24 * 3600) return 15000n;
  if (durSec < 3 * 86400) return 20000n;
  if (durSec < 7 * 86400) return 25000n;
  return 30000n;
}

// 持币时间加权分红金库专用(holderCount/getHolders/userInfo(...,holdStart)/pokeMany)。
// 钻石手长期持有不交易 → 时间倍率涨了但 effShare 还是旧档 → keeper 帮其 poke 升档拿到应得权重。
// 非该类金库(无 holderCount)→ revert → 静默跳过。keeper 挂了不丢钱(用户 claim/转账时自动升档)。
const HTW_VAULT_ABI = [
  "function holderCount() view returns (uint256)",
  "function getHolders(uint256,uint256) view returns (address[])",
  "function userInfo(address) view returns (uint256 amount,uint256 effShare,uint256 rewardDebt,uint256 holdStart)",
  "function pokeMany(address[])",
];
// HTW 金库的时间档(中等尺度,与合约一致):<6h 1× / <1d 1.2× / <3d 1.5× / <7d 2× / <14d 2.5× / ≥14d 3×。
function multBpsHTW(durSec) {
  if (durSec < 6 * 3600) return 10000n;
  if (durSec < 86400) return 12000n;
  if (durSec < 3 * 86400) return 15000n;
  if (durSec < 7 * 86400) return 20000n;
  if (durSec < 14 * 86400) return 25000n;
  return 30000n;
}

// 持有 LP 分红金库(LPHolderDividendVaultU)专用。它【不被 token 推送】(无 setShare),持有人名单只能由
// keeper / 用户自登记维护。keeper 干两件事:① 扫最近 LP Transfer 把新 LP 持有人 addHolders 登记进去;
// ② 池子达门槛就 processReward 按 LP 比例派发(BNB/USDT)。holderRewardCondition() 作类型探针(独有 → 非该类金库 revert 跳过)。
const LP_HOLDER_VAULT_ABI = [
  "function holderRewardCondition() view returns (uint256)",
  "function quoteToken() view returns (address)",
  "function lpToken() view returns (address)",
  "function holderCount() view returns (uint256)",
  "function getHolders(uint256,uint256) view returns (address[])",
  "function addHolders(address[])",
  "function processReward(uint256)",
];
const PAIR_TRANSFER_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
];
// 每轮回扫多少区块找新 LP 持有人(BSC ~3s/块;默认 5000 ≈ 4 小时)。keeper 跑得勤就能很快登记到。
const LPHOLDER_SCAN_BLOCKS = Number(process.env.LPHOLDER_SCAN_BLOCKS || "5000");
const LPHOLDER_REWARD_GAS = BigInt(process.env.LPHOLDER_REWARD_GAS || "2000000"); // processReward 内部轮询 gas 预算
const DEAD_ADDR = "0x000000000000000000000000000000000000dead";

const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
const wallet = new ethers.Wallet(PK, provider);

// 本轮时间预算:到点就干净收尾、exit 0(剩余代币下一轮继续),绝不被 GitHub 的 timeout-minutes 硬掐成 failed。
// keeper 本就是 best-effort,漏跑只是延迟,用户随时可自领 → 提前结束完全安全。默认 12 分钟(工作流给 15 分钟留余量)。
const DEADLINE_MS = Number(process.env.DEADLINE_MS || 12 * 60 * 1000);
const startedAt = Date.now();
const timeUp = () => Date.now() - startedAt > DEADLINE_MS;
// 每笔交易最多等 90s 确认,防单个 tx.wait() 卡死(RPC 抽风)吃光整轮预算。超时按失败处理,下轮重试。
const WAIT_CONFIRMS = 1;
const WAIT_TIMEOUT_MS = 90_000;

async function processToken(tokenAddr) {
  const token = new ethers.Contract(tokenAddr, TOKEN_ABI, wallet);
  if ((await token.startTradeBlock()) === 0n) return; // 未开盘,无分红
  // 自带分红桶=0 的币(分红走金库)→ 不必扫持有人 distributeTo,交给金库 snowball,省 RPC、免噪音。
  try { if (Number(await token.bucketDividendBps()) === 0) return; } catch { return; }

  const n = Number(await token.holderCount());
  if (n === 0) return;

  // 读所有持有人 → 算谁欠分红(分块并发读;allSettled 容忍 RPC 偶发抽风,不中断整轮)
  const owed = [];
  for (let i = 0; i < n; i += 50) {
    const idxs = Array.from({ length: Math.min(50, n - i) }, (_, k) => i + k);
    const addrsR = await Promise.allSettled(idxs.map((j) => token.holderAt(j)));
    const addrs = addrsR.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const amtsR = await Promise.allSettled(addrs.map((a) => token.withdrawableDividendOf(a)));
    amtsR.forEach((r, k) => { if (r.status === "fulfilled" && r.value >= MIN_OWED) owed.push(addrs[k]); });
  }
  if (owed.length === 0) return;

  // 分批 distributeTo
  for (let i = 0; i < owed.length; i += BATCH) {
    if (timeUp()) { console.log(`[${tokenAddr}] 时间预算用尽,distributeTo 余下 ${owed.length - i} 人下轮继续`); break; }
    const slice = owed.slice(i, i + BATCH);
    try {
      const tx = await token.distributeTo(slice);
      const rc = await tx.wait(WAIT_CONFIRMS, WAIT_TIMEOUT_MS);
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
      const rc = await (await vault.syncPlatformDividend()).wait(WAIT_CONFIRMS, WAIT_TIMEOUT_MS);
      console.log(`[vault ${vaultAddr}] syncPlatformDividend → tx ${rc.hash}`);
    }
  } catch { /* 非 DWC 金库 / 无此方法 → 跳过 */ }
  // 2. 读金库状态。读不到 = 非 DWC 金库(如 LP 托管金库)→ 静默跳过。
  let secs, divB, buyB;
  try {
    [secs, divB, buyB] = await Promise.all([
      vault.secondsUntilNextSnowball(),
      vault.dividendBudget(),
      vault.buybackBudget(),
    ]);
  } catch { return; } // 非 DWC 金库,不打日志
  const fmt = (x) => ethers.formatEther(x);
  console.log(`[vault ${vaultAddr}] secsToNext=${secs} dividendBudget=${fmt(divB)} buybackBudget=${fmt(buyB)}`);
  // 轮次到 + 任一池满 perLeg 才触发(省 gas,避免空跑);否则打日志说明原因。
  if (secs !== 0n) { console.log(`[vault ${vaultAddr}] 未到下一轮(还差 ${secs}s),跳过`); return; }
  if (divB < PER_LEG && buyB < PER_LEG) { console.log(`[vault ${vaultAddr}] 两池均未满 ${fmt(PER_LEG)} BNB,跳过`); return; }
  try {
    // 显式高 gas:两条腿(尤其买 $WHALE 这种带税+分红的复杂币)实测 ~1.07M,合约还有 gasleft 地板,
    // 给 2M 留足余量(用不完自动退,只按实际用量计费)。
    const rc = await (await vault.snowball({ gasLimit: 2000000 })).wait(WAIT_CONFIRMS, WAIT_TIMEOUT_MS);
    console.log(`[vault ${vaultAddr}] snowball ✅ → tx ${rc.hash}`);
  } catch (e) {
    console.error(`[vault ${vaultAddr}] snowball 失败:`, e.shortMessage || e.message);
  }
}

async function processFactory(factoryAddr) {
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
  const count = Number(await factory.launchCount());
  const nowTs = Number((await provider.getBlock("latest")).timestamp); // LP 金库判档用链上时间
  console.log(`扫描工厂 ${factoryAddr} 的 ${count} 个 v2 代币 · keeper ${wallet.address}`);
  for (let i = 0; i < count; i++) {
    if (timeUp()) { console.log(`⏱ 本轮时间预算用尽,已处理至 #${i}/${count}(工厂 ${factoryAddr}),剩余下轮继续`); break; }
    let info;
    try {
      info = await factory.launches(i);
    } catch (e) {
      console.error(`launch #${i} 读取失败:`, e.shortMessage || e.message);
      continue;
    }
    // 手动跳过名单
    if (SKIP.has(String(info.token).toLowerCase())) { console.log(`launch #${i} 在 SKIP 名单,忽略`); continue; }
    // ① 内盘/未开盘:startTradeBlock==0 → 还没开盘交易、没税没分红,跳过(不是死币)。
    try {
      const stb = await new ethers.Contract(info.token, TOKEN_ABI, provider).startTradeBlock();
      if (stb === 0n) { console.log(`launch #${i} (${info.token}) 内盘未开盘,无分红,跳过`); continue; }
    } catch { console.log(`launch #${i} 读 startTradeBlock 失败,跳过`); continue; }
    // ② 死币:已开盘但底池 WBNB 太低 → 代币已崩,别拿金库 BNB 砸进枯竭的池子(金库 BNB 留在原地不动)。
    try {
      const pair = new ethers.Contract(info.pair, PAIR_ABI, provider);
      const [r, t0] = await Promise.all([pair.getReserves(), pair.token0()]);
      const wbnbRes = String(t0).toLowerCase() === WBNB.toLowerCase() ? r[0] : r[1];
      if (wbnbRes < MIN_POOL_BNB) {
        console.log(`launch #${i} (${info.token}) 已开盘但底池仅 ${ethers.formatEther(wbnbRes)} BNB < ${ethers.formatEther(MIN_POOL_BNB)},判定死币,跳过`);
        continue;
      }
    } catch { continue; } // 池子读不到 → 本轮跳过
    // token 与金库分开 try:代币侧报错(如 RPC 偶发 missing revert data)不能连累金库 snowball。
    try { await processToken(info.token); } catch (e) { console.error(`launch #${i} token:`, e.shortMessage || e.message); }
    // 分红金库 = taxVault(索引2),不是 vault(索引1,那是 LP 托管金库,没有 snowball)。
    try { await processVault(info.taxVault); } catch (e) { console.error(`launch #${i} vault:`, e.shortMessage || e.message); }
    // LP 质押分红金库:升档 poke(非 LP 金库会被静默跳过)。
    try { await processLPVault(info.taxVault, nowTs); } catch (e) { console.error(`launch #${i} LP vault:`, e.shortMessage || e.message); }
    // 储备托底(Floor)金库:把待买 BNB 换成储备币(非 Floor 金库会被静默跳过)。
    try { await processFloorVault(info.taxVault); } catch (e) { console.error(`launch #${i} Floor vault:`, e.shortMessage || e.message); }
    // 持币时间加权分红金库:升档 poke(非该类金库会被静默跳过)。
    try { await processHTWVault(info.taxVault, nowTs); } catch (e) { console.error(`launch #${i} HTW vault:`, e.shortMessage || e.message); }
    // 持有 LP 分红金库:登记新 LP 持有人 + 派发(非该类金库会被静默跳过)。
    try { await processLPHolderVault(info.taxVault); } catch (e) { console.error(`launch #${i} LPHolder vault:`, e.shortMessage || e.message); }
  }
}

// LP 质押分红金库:遍历质押者,只给"已跨档但还没升级"的人 poke(分批),把时间加成升到位。
// 非 LP 金库(无 stakerCount)→ 第一行就 revert → 静默跳过。keeper 挂了也不丢钱,用户 claim 时自动升级。
async function processLPVault(vaultAddr, nowTs) {
  if (!vaultAddr || vaultAddr === ethers.ZeroAddress) return;
  const v = new ethers.Contract(vaultAddr, LP_VAULT_ABI, wallet);
  let n;
  try { n = Number(await v.stakerCount()); } catch { return; } // 非 LP 金库
  if (n === 0) return;
  const need = [];
  for (let i = 0; i < n; i += 100) {
    let addrs;
    try { addrs = await v.getStakers(i, 100); } catch { break; }
    const infos = await Promise.allSettled(addrs.map((a) => v.userInfo(a)));
    infos.forEach((r, k) => {
      if (r.status !== "fulfilled") return;
      const { amount, effShare, stakeStart } = r.value;
      if (amount === 0n || stakeStart === 0n) return;            // 已退出
      const appliedBps = (effShare * 10000n) / amount;            // 当前计酬倍率
      const curBps = multBps(nowTs - Number(stakeStart));         // 应有倍率
      if (curBps > appliedBps) need.push(addrs[k]);               // 跨档没升 → 要 poke
    });
  }
  if (need.length === 0) { console.log(`[LP vault ${vaultAddr}] ${n} 质押者,无人需升档`); return; }
  for (let i = 0; i < need.length; i += 100) {
    if (timeUp()) { console.log(`[LP vault ${vaultAddr}] 时间预算用尽,pokeMany 余下下轮继续`); break; }
    const slice = need.slice(i, i + 100);
    try {
      const rc = await (await v.pokeMany(slice, { gasLimit: 3000000 })).wait(WAIT_CONFIRMS, WAIT_TIMEOUT_MS);
      console.log(`[LP vault ${vaultAddr}] pokeMany ${slice.length} 人升档 ✅ tx ${rc.hash}`);
    } catch (e) {
      console.error(`[LP vault ${vaultAddr}] pokeMany 失败:`, e.shortMessage || e.message);
    }
  }
}

// 储备代币托底(Floor)金库:把积累的税费 BNB 换成储备币,推高底价。
// vaultStatus() 作类型探针:非 Floor 金库无此方法 → revert → 静默跳过。
// 余额 < PER_LEG 不动手(避免 dust swap 浪费 gas);buyPendingReserve 自带 nonReentrant + 失败 BNB 留库。
async function processFloorVault(vaultAddr) {
  if (!vaultAddr || vaultAddr === ethers.ZeroAddress) return;
  const v = new ethers.Contract(vaultAddr, FLOOR_VAULT_ABI, wallet);
  try { await v.vaultStatus(); } catch { return; } // 非 Floor 金库
  let bal;
  try { bal = await provider.getBalance(vaultAddr); } catch { return; }
  if (bal < PER_LEG) { console.log(`[Floor vault ${vaultAddr}] 待买 ${ethers.formatEther(bal)} BNB < ${ethers.formatEther(PER_LEG)},跳过`); return; }
  try {
    const rc = await (await v.buyPendingReserve({ gasLimit: 1500000 })).wait(WAIT_CONFIRMS, WAIT_TIMEOUT_MS);
    console.log(`[Floor vault ${vaultAddr}] buyPendingReserve ${ethers.formatEther(bal)} BNB ✅ tx ${rc.hash}`);
  } catch (e) {
    console.error(`[Floor vault ${vaultAddr}] buyPendingReserve 失败:`, e.shortMessage || e.message);
  }
}

// 持币时间加权分红金库:遍历持有人,只给"已跨档但还没升级"的人 poke(分批),把时间倍率升到位。
// 非该类金库(无 holderCount)→ 第一行就 revert → 静默跳过。
async function processHTWVault(vaultAddr, nowTs) {
  if (!vaultAddr || vaultAddr === ethers.ZeroAddress) return;
  const v = new ethers.Contract(vaultAddr, HTW_VAULT_ABI, wallet);
  let n;
  try { n = Number(await v.holderCount()); } catch { return; } // 非 HTW 金库
  if (n === 0) return;
  const need = [];
  for (let i = 0; i < n; i += 100) {
    let addrs;
    try { addrs = await v.getHolders(i, 100); } catch { break; }
    const infos = await Promise.allSettled(addrs.map((a) => v.userInfo(a)));
    infos.forEach((r, k) => {
      if (r.status !== "fulfilled") return;
      const { amount, effShare, holdStart } = r.value;
      if (amount === 0n || holdStart === 0n) return;            // 已清零/卖光
      const appliedBps = (effShare * 10000n) / amount;          // 当前计酬倍率
      const curBps = multBpsHTW(nowTs - Number(holdStart));     // 应有倍率
      if (curBps > appliedBps) need.push(addrs[k]);             // 跨档没升 → 要 poke
    });
  }
  if (need.length === 0) { console.log(`[HTW vault ${vaultAddr}] ${n} 持有人,无人需升档`); return; }
  for (let i = 0; i < need.length; i += 100) {
    if (timeUp()) { console.log(`[HTW vault ${vaultAddr}] 时间预算用尽,pokeMany 余下下轮继续`); break; }
    const slice = need.slice(i, i + 100);
    try {
      const rc = await (await v.pokeMany(slice, { gasLimit: 3000000 })).wait(WAIT_CONFIRMS, WAIT_TIMEOUT_MS);
      console.log(`[HTW vault ${vaultAddr}] pokeMany ${slice.length} 人升档 ✅ tx ${rc.hash}`);
    } catch (e) {
      console.error(`[HTW vault ${vaultAddr}] pokeMany 失败:`, e.shortMessage || e.message);
    }
  }
}

// 持有 LP 分红金库:① 扫最近 LP Transfer 登记新持有人(best-effort);② 池达门槛就按 LP 比例派发报价币。
// 非该类金库(无 holderRewardCondition)→ 第一行 revert → 静默跳过。RPC 不支持 getLogs 时登记跳过,靠用户自登记兜底。
async function processLPHolderVault(vaultAddr) {
  if (!vaultAddr || vaultAddr === ethers.ZeroAddress) return;
  const v = new ethers.Contract(vaultAddr, LP_HOLDER_VAULT_ABI, wallet);
  let cond, quote;
  try { cond = await v.holderRewardCondition(); } catch { return; } // 非 LPHolder 金库
  try { quote = await v.quoteToken(); } catch { quote = ethers.ZeroAddress; }

  // ① 登记新 LP 持有人(扫最近区块的 LP Transfer;失败则跳过,用户可自行 syncLPHolder 兜底)
  try {
    const lp = await v.lpToken();
    const latest = await provider.getBlockNumber();
    const fromB = Math.max(0, latest - LPHOLDER_SCAN_BLOCKS);
    const pair = new ethers.Contract(lp, PAIR_TRANSFER_ABI, provider);
    const logs = await pair.queryFilter(pair.filters.Transfer(), fromB, latest);
    const cands = new Set();
    for (const lg of logs) { if (lg.args) { cands.add(lg.args[0]); cands.add(lg.args[1]); } }
    const existing = new Set();
    const hn = Number(await v.holderCount());
    for (let i = 0; i < hn; i += 200) { try { (await v.getHolders(i, 200)).forEach((a) => existing.add(a.toLowerCase())); } catch { break; } }
    const skip = new Set([ethers.ZeroAddress.toLowerCase(), DEAD_ADDR, lp.toLowerCase(), vaultAddr.toLowerCase()]);
    const lpRead = new ethers.Contract(lp, ["function balanceOf(address) view returns (uint256)"], provider);
    const toAdd = [];
    for (const a of cands) {
      const al = a.toLowerCase();
      if (skip.has(al) || existing.has(al)) continue;
      let b; try { b = await lpRead.balanceOf(a); } catch { continue; }
      if (b > 0n) toAdd.push(a);
    }
    for (let i = 0; i < toAdd.length; i += 100) {
      if (timeUp()) break;
      const slice = toAdd.slice(i, i + 100);
      const rc = await (await v.addHolders(slice, { gasLimit: 4000000 })).wait(WAIT_CONFIRMS, WAIT_TIMEOUT_MS);
      console.log(`[LPHolder ${vaultAddr}] addHolders ${slice.length} 个新 LP 持有人 ✅ tx ${rc.hash}`);
    }
  } catch (e) {
    console.log(`[LPHolder ${vaultAddr}] 登记跳过(getLogs 不支持/无新增):${e.shortMessage || e.message}`);
  }

  // ② 派发(池子达门槛才调,省 gas;报价币 BNB 看 this.balance / ERC20 看 balanceOf)
  try {
    const pot = (quote === ethers.ZeroAddress)
      ? await provider.getBalance(vaultAddr)
      : await new ethers.Contract(quote, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf(vaultAddr);
    if (pot < cond) { console.log(`[LPHolder ${vaultAddr}] 池 ${ethers.formatEther(pot)} < 门槛 ${ethers.formatEther(cond)},跳过派发`); return; }
    const rc = await (await v.processReward(LPHOLDER_REWARD_GAS, { gasLimit: 3000000 })).wait(WAIT_CONFIRMS, WAIT_TIMEOUT_MS);
    console.log(`[LPHolder ${vaultAddr}] processReward 派发 ✅ tx ${rc.hash}`);
  } catch (e) {
    console.error(`[LPHolder ${vaultAddr}] processReward 失败:`, e.shortMessage || e.message);
  }
}

async function runOnce() {
  // 遍历所有工厂(新+旧),任一工厂报错不影响其它工厂。
  for (const f of FACTORIES) {
    try { await processFactory(f); }
    catch (e) { console.error(`工厂 ${f} 扫描失败:`, e.shortMessage || e.message); }
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
