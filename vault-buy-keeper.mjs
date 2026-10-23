// Whale.fun 金库买入 keeper —— 只做一件事:替"延后买入"的金库把攒着的报价币花出去。
//
// 背景:审计版代币给金库打款只带 100,000 gas,金库收款时不能再做兑换,所以
//   · 储备托底金库(TaxReserveFloorVaultU)的"买储备币"
//   · LP 质押分红金库(LPStakingDividendVaultU)的"回购销毁"
// 都改成了由外部调用触发,且每次买入有上限(BoundedBuyV1):每 60 秒最多一笔、每笔不超过池子深度的 0.25%、
// 池子本秒有成交或现价偏离其一分钟均价超过 1% 时不买。攒着的钱因此是分很多笔花完的 ——
// 所以单独有这个脚本,线上每 5 分钟一轮(2026-10-11 定):一天最多消化池深的 72%。
// 间隔可以在 1 分钟到 1 小时之间调 —— 越短换得越快、波动大的池子被"偏离均价"跳过得越少;超过 1 小时合约只会
// 反复刷新读数、永远不买。
//
// 设计:permissionless 调用(buyPendingReserve / sync),热钱包只付 gas、无任何权限;
// 漏跑只是延迟,钱一直在金库里;"这一轮不让买"在链上是便宜的空操作。
// 只认新实现的金库(探针:lastBuyLookAt())。老实现的金库由 dividend-keeper.mjs 照旧处理。
//
// 顺带(2026-10-15 加):燃烧池金库(BurnPoolVault)的到点 poke —— 见 tryBurnPool 上面的说明。
//
// 运行:  node vault-buy-keeper.mjs          (跑一轮就退出;由 cron-job.org 打 workflow_dispatch 触发)
// 环境变量:
//   RPC_URL            BSC RPC,可多个(逗号分隔),按顺序挑第一个"肯收交易"的
//   KEEPER_PK          热钱包私钥(只放少量 BNB 付 gas)。线上和 dividend-keeper 共用同一个钱包,
//                      靠两个 workflow 在同一个并发组里排队来避免撞 nonce;本地手动跑时别和线上那轮撞车。
//   LAUNCH_FACTORY_V2  mint 工厂地址,可多个(逗号分隔)—— 新审计版工厂部署后填这里
//   CURVE_FACTORIES    曲线工厂地址,可多个(逗号分隔)
//   BURN_POOL_FACTORIES 燃烧池金库工厂地址,可多个(逗号分隔)—— 脚本自己从工厂绑定的 mint 工厂里找出它建的金库
//   MIN_PENDING_WEI    待买金额折成 BNB 低于此值不动手(默认 1e15 = 0.001 BNB,约为一次买入 gas 的 50 倍)
//   DRY_RUN=1          只打印会做什么,不发交易

import { ethers } from "ethers";

// 公共节点对机房 IP 常常"只封写不封读"(读全通、一发交易就 403),所以配一组候选,开跑前逐个探测写通道。
const RPCS = (process.env.RPC_URL || "https://bsc-dataseed.bnbchain.org,https://rpc-bsc.48.club,https://bsc-dataseed1.defibit.io,https://bsc-rpc.publicnode.com")
  .split(",").map((s) => s.trim()).filter(Boolean);
const PK = (() => { const k = (process.env.KEEPER_PK || "").trim(); return k ? (k.startsWith("0x") ? k : "0x" + k) : k; })();
const list = (v) => (v || "").split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
const MINT_FACTORIES = list(process.env.LAUNCH_FACTORY_V2);
const CURVE_FACTORIES = list(process.env.CURVE_FACTORIES);
const BURN_POOL_FACTORIES = list(process.env.BURN_POOL_FACTORIES);
const MIN_PENDING = BigInt(process.env.MIN_PENDING_WEI || "1000000000000000");
const WBNB = process.env.WBNB || "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const DEX_FACTORY = process.env.DEX_FACTORY || "0xcA143Ce32Fe78f1f9019d7d551a6402fC5350c73"; // PancakeSwap V2
const DRY = process.env.DRY_RUN === "1";
const BUY_INTERVAL = 60n; // BoundedBuyV1.BUY_INTERVAL
const GAS_LIMIT = 900000n; // 实测一次有界买入 30~36 万 gas(两跳路径更高);给足余量,用不完自动退
const TRIGGER_SERVICE = "0xcf4EE25035CF883895110f367F5BA8172416a7F9"; // FlapTriggerService(燃烧池金库自己预约回调用的)
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const STALE_GRACE = 1800n; // BurnPoolVault.STALE_GRACE:预约时间过了这么久还没回调,合约自己也当它作废、允许重新预约
const REF_WINDOW = 600n; // BurnPoolVault.REF_WINDOW:金库参考价两次更新至少隔这么久,不满 10 分钟 poke 也不更新
const PRICE_LAG_BPS = BigInt(process.env.BURN_POOL_PRICE_LAG_BPS || "100"); // 金库价和现价差到这个比例(默认 1%)才去刷新
const POKE_GAS_LIMIT = 1500000n; // 实测空 poke 约 18 万 gas、帮烧一轮 + 重新预约约 41 万;再叠上拉盘买币也远低于此,用不完自动退

if ((!PK && !DRY) || MINT_FACTORIES.length + CURVE_FACTORIES.length + BURN_POOL_FACTORIES.length === 0) {
  console.error("缺少 KEEPER_PK,或 LAUNCH_FACTORY_V2 / CURVE_FACTORIES / BURN_POOL_FACTORIES 都没填");
  process.exit(1);
}

// 探测法:发一笔格式错误的假交易。回 JSON-RPC 错误 = 写通道开放;回 HTTP 4xx/超时 = 被封,换下一个。不花 gas、不上链。
async function pickRpc() {
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0xdeadbeef"] }),
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok && (await r.json()).error) return url;
      console.log(`RPC ${new URL(url).host} 不收交易(HTTP ${r.status}),换下一个`);
    } catch (e) { console.log(`RPC ${new URL(url).host} 探测失败(${e.name}),换下一个`); }
  }
  throw new Error("候选 RPC 全部不收交易");
}

let provider, wallet, signerOrProvider, failed = 0;
let nextNonce = null; // 自己数 nonce:一轮里连发几笔时,节点/库的缓存会把上一笔还没算进去的旧值再给一遍

const MINT_FACTORY_ABI = [
  "function launchCount() view returns (uint256)",
  "function launches(uint256) view returns (address token,address vault,address taxVault,address pair,address creator,uint256 createdAt)",
];
const CURVE_FACTORY_ABI = [
  "function launchCount() view returns (uint256)",
  "function launches(uint256) view returns (address)",
];
const TAX_VAULT_OF = ["function taxVault() view returns (address)"];
const BOUNDED_ABI = ["function lastBuyLookAt() view returns (uint256)"];
const FLOOR_ABI = [
  "function quoteToken() view returns (address)",
  "function pendingQuote() view returns (uint256)",
  "function buyPendingReserve()",
];
const LPS_ABI = [
  "function paused() view returns (bool)",
  "function quoteToken() view returns (address)",
  "function totalDistributed() view returns (uint256)",
  "function totalClaimed() view returns (uint256)",
  "function totalForfeited() view returns (uint256)",
  "function pendingDust() view returns (uint256)",
  "function BUYBACK_THRESHOLD() view returns (uint256)",
  "function unownedQuote() view returns (uint256)",
  "function sync()",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const DEX_FACTORY_ABI = ["function getPair(address,address) view returns (address)"];
const PAIR_ABI = [
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
];
const BURN_POOL_FACTORY_ABI = [
  "function implementation() view returns (address)",
  "function vaultPortal() view returns (address)",
];
const BURN_POOL_ABI = [
  "function lastBurner() view returns (address)",
  "function nextRoundAt() view returns (uint256)",
  "function scheduled() view returns (bool)",
  "function scheduledFor() view returns (uint64)",
  "function roundCount() view returns (uint256)",
  "function pendingRequestId() view returns (uint256)",
  "function refPrice() view returns (uint256)",
  "function obsTime() view returns (uint256)",
  "function spotPrice() view returns (uint256)",
  "function poke()",
];
const TRIGGER_ABI = ["function getFee() view returns (uint256)"];
const MULTICALL3_ABI = [
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)",
];

// 报价币数量折成 BNB(只用来决定"值不值得发这笔交易",不参与任何链上定价)。
// 报价币精度和单价差得很远(USDT 18 位、DOGE 8 位、BTCB 一枚几万美元),按原始数量设门槛必然有的永远不触发、有的白烧 gas。
// 没有 WBNB 池的报价币 → 返回 null,调用方只要 > 0 就试(链上空操作很便宜)。
const rateCache = new Map();
async function inBnb(quote, amount) {
  if (quote === ethers.ZeroAddress || quote.toLowerCase() === WBNB.toLowerCase()) return amount;
  if (!rateCache.has(quote)) {
    let rate = null;
    try {
      const pair = await new ethers.Contract(DEX_FACTORY, DEX_FACTORY_ABI, provider).getPair(quote, WBNB);
      if (pair !== ethers.ZeroAddress) {
        const p = new ethers.Contract(pair, PAIR_ABI, provider);
        const [t0, r] = await Promise.all([p.token0(), p.getReserves()]);
        const [rQ, rB] = t0.toLowerCase() === quote.toLowerCase() ? [r[0], r[1]] : [r[1], r[0]];
        if (rQ > 0n) rate = [rB, rQ];
      }
    } catch { /* 读不到就当没有 */ }
    rateCache.set(quote, rate);
  }
  const rate = rateCache.get(quote);
  return rate ? (amount * rate[0]) / rate[1] : null;
}
const worthIt = (bnb, amount) => (bnb === null ? amount > 0n : bnb >= MIN_PENDING);
const fmtBnb = (bnb) => (bnb === null ? "无 BNB 报价" : `≈${ethers.formatEther(bnb)} BNB`);

async function vaultsOf() {
  const out = new Set();
  for (const f of MINT_FACTORIES) {
    try {
      const c = new ethers.Contract(f, MINT_FACTORY_ABI, provider);
      const n = Number(await c.launchCount());
      const infos = await Promise.allSettled(Array.from({ length: n }, (_, i) => c.launches(i)));
      for (const r of infos) if (r.status === "fulfilled" && r.value.taxVault !== ethers.ZeroAddress) out.add(r.value.taxVault);
      console.log(`mint 工厂 ${f}: ${n} 个币`);
    } catch (e) { console.error(`mint 工厂 ${f} 读取失败:`, e.shortMessage || e.message); }
  }
  for (const f of CURVE_FACTORIES) {
    try {
      const c = new ethers.Contract(f, CURVE_FACTORY_ABI, provider);
      const n = Number(await c.launchCount());
      const tokens = await Promise.allSettled(Array.from({ length: n }, (_, i) => c.launches(i)));
      const tvs = await Promise.allSettled(
        tokens.filter((r) => r.status === "fulfilled").map((r) => new ethers.Contract(r.value, TAX_VAULT_OF, provider).taxVault())
      );
      for (const r of tvs) if (r.status === "fulfilled" && r.value !== ethers.ZeroAddress) out.add(r.value);
      console.log(`曲线工厂 ${f}: ${n} 个币`);
    } catch (e) { console.error(`曲线工厂 ${f} 读取失败:`, e.shortMessage || e.message); }
  }
  return [...out];
}

// 燃烧池工厂没有列出金库的接口(只发 VaultCreated 事件,公共节点的 getLogs 又基本被封),所以反过来找:
// 工厂只接受它绑定的 mint 工厂(vaultPortal)调用,建出来的金库就是那边某个币的 taxVault,而且是工厂 implementation 的
// 最小代理克隆(EIP-1167)—— 逐个币比对 taxVault 的字节码,新发的燃烧池币不用改配置就会被找到。
async function burnPoolVaults() {
  const out = new Set();
  for (const f of BURN_POOL_FACTORIES) {
    try {
      const c = new ethers.Contract(f, BURN_POOL_FACTORY_ABI, provider);
      const [impl, portal] = await Promise.all([c.implementation(), c.vaultPortal()]);
      const lf = new ethers.Contract(portal, MINT_FACTORY_ABI, provider);
      const n = Number(await lf.launchCount());
      const infos = await Promise.allSettled(Array.from({ length: n }, (_, i) => lf.launches(i)));
      const tvs = infos.filter((r) => r.status === "fulfilled" && r.value.taxVault !== ethers.ZeroAddress).map((r) => r.value.taxVault);
      const codes = await Promise.allSettled(tvs.map((a) => provider.getCode(a)));
      const clone = `0x363d3d373d3d3d363d73${impl.slice(2)}5af43d82803e903d91602b57fd5bf3`.toLowerCase();
      let found = 0;
      codes.forEach((r, i) => { if (r.status === "fulfilled" && r.value.toLowerCase() === clone) { out.add(tvs[i]); found++; } });
      console.log(`燃烧池工厂 ${f}: 绑定 mint 工厂 ${portal}(${n} 个币),其中燃烧池金库 ${found} 个`);
    } catch (e) { console.error(`燃烧池工厂 ${f} 读取失败:`, e.shortMessage || e.message); }
  }
  return [...out];
}

// 新实现的探针 + 间隔是否已过。读不到 lastBuyLookAt = 不是新实现 → 跳过。
async function windowOpen(vault, now) {
  let at;
  try { at = await new ethers.Contract(vault, BOUNDED_ABI, provider).lastBuyLookAt(); } catch { return null; }
  return at === 0n || now >= at + BUY_INTERVAL;
}

async function send(label, vault, fn) {
  if (DRY) { console.log(`[DRY] ${label} ${vault}`); return; }
  try {
    if (nextNonce === null) nextNonce = await provider.getTransactionCount(wallet.address, "pending");
    const sent = await fn({ gasLimit: GAS_LIMIT, nonce: nextNonce });
    nextNonce++;
    const rc = await sent.wait(1, 60_000);
    console.log(`${label} ${vault} ✅ gas ${rc.gasUsed} tx ${rc.hash}`);
  } catch (e) {
    nextNonce = null; // 不确定这笔占没占 nonce → 下一笔重新问链
    failed++;
    console.error(`${label} ${vault} 失败:`, e.shortMessage || e.message);
  }
}

async function tryFloor(vault) {
  const v = new ethers.Contract(vault, FLOOR_ABI, signerOrProvider);
  let pending, quote;
  try { [pending, quote] = await Promise.all([v.pendingQuote(), v.quoteToken()]); } catch { return false; } // 不是(新)托底金库
  const bnb = await inBnb(quote, pending);
  if (!worthIt(bnb, pending)) return true;
  await send(`托底金库 buyPendingReserve(待买 ${fmtBnb(bnb)})`, vault, (o) => v.buyPendingReserve(o));
  return true;
}

async function tryLps(vault) {
  const v = new ethers.Contract(vault, LPS_ABI, signerOrProvider);
  let paused, quote, dist, claimed, forfeited, dust, unit;
  try {
    [paused, quote, dist, claimed, forfeited, dust, unit] = await Promise.all([
      v.paused(), v.quoteToken(), v.totalDistributed(), v.totalClaimed(), v.totalForfeited(), v.pendingDust(), v.BUYBACK_THRESHOLD(),
    ]);
  } catch { return false; } // 不是(新)质押分红金库
  if (paused) return true;
  // 金库里不欠任何人的那部分。合约自己给了准确值(unownedQuote:有人质押时会把尚未入账的新收入算作质押者的);
  // 读不到时退回估算 = 余额 − (已记给质押者 + 待分零头 − 已领 − 已放弃),它可能偏大,多发一笔空操作无妨。
  let spendable;
  try { spendable = await v.unownedQuote(); } catch {
    const bal = quote === ethers.ZeroAddress
      ? await provider.getBalance(vault)
      : await new ethers.Contract(quote, ERC20_ABI, provider).balanceOf(vault);
    const credited = dist + dust, gone = claimed + forfeited;
    const owed = credited > gone ? credited - gone : 0n;
    spendable = bal > owed ? bal - owed : 0n;
  }
  if (spendable < unit) return true; // 合约自己的最小回购单位,不到这个数链上也不会买
  const bnb = await inBnb(quote, spendable);
  if (!worthIt(bnb, spendable)) return true;
  await send(`质押分红金库 sync(可回购 ${fmtBnb(bnb)})`, vault, (o) => v.sync(o));
  return true;
}

const fmtTime = (ts) => new Date((Number(ts) + 8 * 3600) * 1000).toISOString().slice(5, 16).replace("T", " ") + "(UTC+8)";
const fmtLeft = (s) => `${s / 3600n} 小时 ${(s % 3600n) / 60n} 分`;

// 燃烧池金库(BurnPoolVault):"12 小时无人燃烧 → 储备池替最后燃烧人烧 100U"是懒执行的,只在 poke / 存币 / 定时回调里跑。
// 金库靠 FlapTriggerService 预约回调,可金库 BNB 付不起预约费时定时器就停了,到点的轮次要等下一个人交互才执行
// (2026-10-15 鲸鱼人生有人投诉"到点没帮烧")。所以这里替它调 permissionless 的 poke(),热钱包只付 gas。满足任一条件才考虑:
//   (a) 有最后燃烧人,且已到点
//   (b) 定时器没在预约(或预约已过期),且金库余额够付预约费 —— poke 会顺带重新预约
//   (c) 金库价(参考价)满 10 分钟没更新,且和现价差 ≥ PRICE_LAG_BPS(默认 1%)。参考价是"上次更新到这次更新"整段的
//       均价、只在有人碰金库时才更新,定时器一停就常常几个小时不动,页面上的金库价跟行情差得很远(2026-10-23 社区反馈)。
//       合约规定两次更新至少隔 10 分钟,这里只在行情真的动了才刷新 —— 这也就是定时器正常时每 10 分钟一次的节奏。
// 发之前先模拟:经 Multicall3 在同一个 eth_call 里先 poke() 再读 roundCount / scheduled / pendingRequestId / obsTime,
// 只有"会帮烧""会预约上"或"金库价会刷新"才发 —— 储备不足一轮、余额扣掉 LP 那半税后不够预约费时 poke 是空操作,不白烧 gas。
async function tryBurnPool(vault, now, fee) {
  const v = new ethers.Contract(vault, BURN_POOL_ABI, signerOrProvider);
  let burner, dueAt, sched, schedFor, rounds, reqId, ref, obsAt, spot, bal;
  try {
    [burner, dueAt, sched, schedFor, rounds, reqId, ref, obsAt, spot, bal] = await Promise.all([
      v.lastBurner(), v.nextRoundAt(), v.scheduled(), v.scheduledFor(), v.roundCount(), v.pendingRequestId(),
      v.refPrice(), v.obsTime(), v.spotPrice(), provider.getBalance(vault),
    ]);
  } catch (e) { console.error(`燃烧池金库 ${vault} 读取失败:`, e.shortMessage || e.message); return false; }
  const hasBurner = burner !== ethers.ZeroAddress;
  const due = hasBurner && now >= dueAt;
  const armed = sched && now <= schedFor + STALE_GRACE;
  const canArm = !armed && fee !== null && bal >= fee;
  const gapBps = ref > 0n && spot > 0n ? ((spot > ref ? spot - ref : ref - spot) * 10000n) / ref : 0n;
  const lagging = obsAt > 0n && now >= obsAt + REF_WINDOW && gapBps >= PRICE_LAG_BPS;
  console.log(
    `燃烧池金库 ${vault}: 帮烧到点 ${hasBurner ? fmtTime(dueAt) + (due ? "(已到点)" : `(还差 ${fmtLeft(dueAt - now)})`) : "—(还没有最后燃烧人)"}` +
      ` · 定时器 ${armed ? "已预约 " + fmtTime(schedFor) : sched ? "预约已过期" : "未预约"}` +
      ` · 余额 ${ethers.formatEther(bal)} BNB / 预约费 ${fee === null ? "读不到" : ethers.formatEther(fee)}` +
      ` · 金库价${spot >= ref ? "低于" : "高于"}现价 ${(Number(gapBps) / 100).toFixed(2)}%(${fmtTime(obsAt)} 更新)`
  );
  if (!due && !canArm && !lagging) { console.log("  → 本轮不 poke"); return false; }

  const mc = new ethers.Interface(MULTICALL3_ABI);
  const reads = ["roundCount", "scheduled", "pendingRequestId", "obsTime"];
  const calls = ["poke", ...reads].map((f) => ({ target: vault, allowFailure: true, callData: v.interface.encodeFunctionData(f) }));
  let roundsAfter, schedAfter, reqIdAfter, obsAfter;
  try {
    const raw = await provider.call({ to: MULTICALL3, from: wallet?.address, data: mc.encodeFunctionData("aggregate3", [calls]) });
    const [res] = mc.decodeFunctionResult("aggregate3", raw);
    if (!res[0].success) { console.log(`  → 模拟 poke() 会回滚(${res[0].returnData}),本轮不发`); return false; }
    [roundsAfter, schedAfter, reqIdAfter, obsAfter] = reads.map((f, i) => v.interface.decodeFunctionResult(f, res[i + 1].returnData)[0]);
  } catch (e) { console.error("  → 模拟失败,本轮不发:", e.shortMessage || e.message); return false; }
  const willBurn = roundsAfter > rounds;
  const willArm = schedAfter && reqIdAfter !== reqId;
  const willRefresh = lagging && obsAfter > obsAt; // 只认(c):否则"到点但储备不足"时会借着刷新价格每 10 分钟空发一笔
  if (!willBurn && !willArm && !willRefresh) {
    console.log("  → 模拟显示这次 poke 不会帮烧、预约不上定时器、金库价也不会刷新,本轮不发");
    return false;
  }
  const what = [willBurn && `帮烧第 ${roundsAfter} 轮`, willArm && "重新预约定时器", willRefresh && "刷新金库价"].filter(Boolean).join(" + ");
  await send(`燃烧池金库 poke(${what})`, vault, (o) => v.poke({ ...o, gasLimit: POKE_GAS_LIMIT }));
  return true;
}

async function main() {
  const rpc = await pickRpc();
  provider = new ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  wallet = PK ? new ethers.Wallet(PK, provider) : null;
  signerOrProvider = wallet || provider;
  console.log(`RPC ${new URL(rpc).host}`);
  // 这个钱包还有交易没上链 = 另一个任务(分红 keeper,或上一轮没收尾)正在用它 → 这一轮不发,免得两边拿到同一个 nonce。
  // 线上有并发组兜着,正常走不到这里;公共节点不一定看得到别人的待打包交易,所以这只是多一道保险。
  if (wallet) {
    const [mined, queued] = await Promise.all([
      provider.getTransactionCount(wallet.address, "latest"),
      provider.getTransactionCount(wallet.address, "pending"),
    ]);
    if (queued > mined) {
      console.log(`热钱包 ${wallet.address} 还有 ${queued - mined} 笔交易在路上,本轮跳过`);
      return;
    }
  }
  const now = BigInt((await provider.getBlock("latest")).timestamp);
  const vaults = await vaultsOf();
  let acted = 0;
  for (const vault of vaults) {
    const open = await windowOpen(vault, now);
    if (open === null) continue; // 老实现
    if (!open) continue; // 距上次记录不足 60 秒
    if (await tryFloor(vault)) { acted++; continue; }
    if (await tryLps(vault)) acted++;
  }
  const pools = await burnPoolVaults();
  let poked = 0;
  if (pools.length) {
    let fee = null; // 读不到预约费就只按"到点"判断
    try { fee = await new ethers.Contract(TRIGGER_SERVICE, TRIGGER_ABI, provider).getFee(); } catch (e) { console.error("读预约费失败:", e.shortMessage || e.message); }
    const t = BigInt((await provider.getBlock("latest")).timestamp); // 上面可能已发过交易、等过确认,重新取时间
    for (const vault of pools) if (await tryBurnPool(vault, t, fee)) poked++;
  }
  console.log(
    `本轮完成:${vaults.length} 个金库,其中 ${acted} 个是有界买入的新实现 · 燃烧池金库 ${pools.length} 个,poke ${poked} 个` +
      (wallet ? " · keeper " + wallet.address : "")
  );
  if (failed) { console.error(`${failed} 笔交易失败`); process.exit(1); } // 让这次运行在 Actions 里显示为红的
}

main().catch((e) => { console.error(e); process.exit(1); });
