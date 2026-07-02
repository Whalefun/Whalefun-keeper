// 诊断 Alchemy BSC eth_getLogs 的块范围上限:依次试 2000/1000/500/100/10 块,
// 打印 Alchemy 返回的原始错误(里面会写明允许的最大范围)。
// 用法:  node test-getlogs.mjs https://bnb-mainnet.g.alchemy.com/v2/<key>
const url = process.argv[2];
if (!url) { console.error("用法: node test-getlogs.mjs <LOGS_RPC_URL>"); process.exit(1); }

const LP = "0xF7f4F69A65876b05AEfAdd4903a69BA1E0eB5DeE"; // 该币的 LP 对

async function rpc(method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  return { status: r.status, body: j };
}

const bn = await rpc("eth_blockNumber", []);
console.log("eth_blockNumber:", bn.status, bn.body.result ?? JSON.stringify(bn.body));
const latest = parseInt(bn.body.result, 16);

for (const span of [2000, 1000, 500, 100, 10]) {
  const from = latest - span + 1;
  const res = await rpc("eth_getLogs", [{
    address: LP,
    fromBlock: "0x" + from.toString(16),
    toBlock: "0x" + latest.toString(16),
  }]);
  const ok = res.status === 200 && res.body.result !== undefined;
  console.log(
    `getLogs ${span} 块:`,
    ok ? `✅ OK(${res.body.result.length} 条)` : `❌ HTTP ${res.status} → ${JSON.stringify(res.body.error ?? res.body).slice(0, 300)}`
  );
}
