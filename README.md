# whalefun-keeper

Permissionless dividend keeper for Whale.fun. On a schedule it:

- For each v2 token: pushes accrued dividends to holders (`distributeTo`).
- For each dividend vault: triggers `snowball()` (buy dividend token + buyback-burn) and cold-start `syncPlatformDividend()`.

Everything it calls is **permissionless** — the hot wallet only pays gas and has **no privileges**. If a round is missed, it just retries next round; holders can always claim manually.

## Setup (one time)

1. **Make a fresh wallet** for the keeper. ⚠️ It must NOT be the owner / deployer / guardian key — generate a brand-new wallet. Fund it with a little BNB (~0.05–0.1) for gas.
2. **Create this as a PUBLIC GitHub repo** (public = free unlimited Actions minutes; private repos cap at 2000 min/month and a 10-min cron exceeds that).
3. **Add the private key as a secret:** repo → Settings → Secrets and variables → Actions → New repository secret
   - Name: `KEEPER_PK`
   - Value: the fresh wallet's private key (`0x...`)
4. Push. It runs automatically (~every 10 min) and can be run manually from the **Actions** tab → *dividend-keeper* → *Run workflow*.

### Optional repo Variables (Settings → Variables)
- `RPC_URL` — BSC mainnet RPC (default: `https://bsc-dataseed.bnbchain.org`)。
  - ⚠️ **「持有 LP 分红」金库自动登记需要 `eth_getLogs`**,公共节点(bsc-dataseed 等)不支持 → 自动登记失效,LP 持有人须手动 `syncLPHolder`。要自动登记:把 RPC 设成支持 getLogs 的端点(如 **Alchemy BSC**)。
  - 🔒 Alchemy URL 含 API key,**放 Secret 名为 `RPC_URL`(Settings → Secrets),不要放 Variable**(公开仓库会泄露 key)。keeper.yml 已优先读 `secrets.RPC_URL`。
  - 扫描已分块(`LOG_CHUNK` 默认 2000 区块/次),兼容 Alchemy 范围上限。
- `LAUNCH_FACTORY_V2` — factory address(es), **comma-separated** (scans all). **你通常不用设它** —— `keeper.yml` 的默认值已经包含了全部工厂(v2.2 + 两个 legacy + v2.4 `0xB5AF…`,「持有 LP 分红」/USDT 金库在此)。
  - ⚠️ 设了这个变量会**整个覆盖**默认值,所以要设就必须把**全部**地址都写上,漏一个那个工厂下的金库就会停派:
  - `0x1230B67525247DA20e56E9f8CAaA263ae670401a,0xaDeb3eaEbA2fE20Afdb20529382e4395FaA2821c,0x2196D9B1Ee3411a4C6E26a417861713151EcdC07,0xB5AF6387ed653F3f15C01Da4031571Fd454DF22f`
- Script-level (env): `MIN_OWED_WEI`, `BATCH`, `VAULT_PER_LEG_WEI`, `LPHOLDER_SCAN_BLOCKS`(持有 LP 分红:每轮回扫多少区块找新 LP 持有人,默认 5000) — see `dividend-keeper.mjs`.

## Run locally (optional)
```bash
npm install
KEEPER_PK=0x... RPC_URL=https://bsc-dataseed.bnbchain.org \
LAUNCH_FACTORY_V2=0x2196D9B1Ee3411a4C6E26a417861713151EcdC07 \
node dividend-keeper.mjs
```

## vault-buy-keeper(延后买入金库的触发器)

`vault-buy-keeper.mjs` + `.github/workflows/vault-buy-keeper.yml`。只服务**审计版工厂**上的两种金库新实现:

- 储备托底金库:调 `buyPendingReserve()` 把攒着的报价币换成储备币;
- LP 质押分红金库:调 `sync()` 做回购销毁(无人质押时也要调)。

这两种金库收税时不再当场兑换(审计版代币打款只带 10 万 gas),买入改为外部触发,且合约自己限速:每 60 秒最多一笔、每笔 ≤ 池深 0.25%、池子本秒有成交或现价偏离其均价超过 1% 时不买。所以它需要 1~2 分钟一轮,而不是 15 分钟。漏跑只是延迟,钱一直在金库里。

设置:
1. **另建一个热钱包**(不要复用 `KEEPER_PK`:两个任务同时发交易会撞 nonce),Secret 名 `VAULT_BUY_KEEPER_PK`。
2. 工厂地址已内置在 workflow 里(BSC 主网审计版 mint 工厂 `0xf21340c8…`、曲线工厂 `0x27Bdd246…`)。换工厂时改默认值,或设 Variables `VAULT_BUY_MINT_FACTORIES` / `VAULT_BUY_CURVE_FACTORIES`(逗号分隔,会整个覆盖默认值)。
3. 触发:workflow 只有 `workflow_dispatch`,由 cron-job.org 每 2 分钟 POST 一次 dispatch 接口(做法见 yml 头部注释)。
4. 可选:`VAULT_BUY_RPC_URL`(逗号分隔的候选;脚本开跑前逐个探测"肯不肯收交易")、`VAULT_BUY_MIN_PENDING_WEI`(待买金额折成 BNB 的门槛,默认 0.001)。

本地空跑(不发交易):
```bash
DRY_RUN=1 LAUNCH_FACTORY_V2=0x... CURVE_FACTORIES=0x... node vault-buy-keeper.mjs
```

有交易失败时脚本以非零退出,这次运行在 Actions 里显示为红色。

## Note
The keeper triggers each vault's snowball every round, but each round only processes a fixed amount per leg — high vault-allocation tokens may still distribute slowly until the vault throughput is upgraded. The keeper makes distribution **happen regularly**; it does not change the per-round amount.
