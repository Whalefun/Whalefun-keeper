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
- `RPC_URL` — BSC mainnet RPC (default: `https://bsc-dataseed.bnbchain.org`)
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

## Note
The keeper triggers each vault's snowball every round, but each round only processes a fixed amount per leg — high vault-allocation tokens may still distribute slowly until the vault throughput is upgraded. The keeper makes distribution **happen regularly**; it does not change the per-round amount.
