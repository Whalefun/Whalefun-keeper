import { ethers } from 'ethers'
const p = new ethers.JsonRpcProvider('https://bsc-dataseed.bnbchain.org')
const LF='0xB5AF6387ed653F3f15C01Da4031571Fd454DF22f', NFTF='0x5542FD41EcD84090Db760Dc9cc73e5A15dd6DAbf'
const ME='0x688b63F94dda23986aa5CD1398D4b2c052888Dc0', Z=ethers.ZeroAddress
const bal = await p.getBalance(ME)
console.log('smallJY 余额:', ethers.formatEther(bal), 'BNB  (需 ≥ 0.005 + gas ≈ 0.006)')
console.log(bal < ethers.parseEther('0.006') ? '  → ⚠️ 不够!这就是 MetaMask 拦截、没上链的原因' : '  → 余额够,继续复现看 revert')
const clFrag={"type":"function","name":"createLaunch","stateMutability":"payable","inputs":[{"name":"cfg","type":"tuple","components":[{"name":"name","type":"string"},{"name":"symbol","type":"string"},{"name":"totalSupply","type":"uint256"},{"name":"mintCount","type":"uint256"},{"name":"unitPriceBNB","type":"uint256"},{"name":"buyTaxBps","type":"uint16"},{"name":"sellTaxBps","type":"uint16"},{"name":"bucketVaultBps","type":"uint16"},{"name":"bucketMarketingBps","type":"uint16"},{"name":"bucketLiquidityBps","type":"uint16"},{"name":"bucketDividendBps","type":"uint16"},{"name":"bucketBurnBps","type":"uint16"},{"name":"marketingWallet","type":"address"},{"name":"quoteToken","type":"address"},{"name":"airdropEnabled","type":"bool"},{"name":"airdropCount","type":"uint8"},{"name":"dividendToken","type":"address"},{"name":"minimumShareBalance","type":"uint256"}]},{"name":"vaultFactory","type":"address"},{"name":"vaultData","type":"bytes"},{"name":"salt","type":"bytes32"}],"outputs":[]}
const iface=new ethers.Interface([clFrag])
const vaultData=ethers.AbiCoder.defaultAbiCoder().encode(['tuple(string,string,uint256,uint256,uint256,uint16,uint16,string)'],[['LABUBU','LABUBU',300n,300n,ethers.parseEther('2000'),90,10,'ipfs://bafybeifrv77itkwm5jlay6ubdu6nx7bw4rp4ksseei57p3dbydsuu2sp7i/']])
const cfg=['LABUBU','LABUBU',ethers.parseEther('1000000'),200n,ethers.parseEther('0.01'),300,300,8000,0,500,0,1500,ME,Z,false,0,Z,0n]
const salt='0x0000000000000000000000000000000000000000000000000000000000000001'
const data=iface.encodeFunctionData('createLaunch',[cfg,NFTF,vaultData,salt])
try { await p.call({to:LF,from:ME,value:ethers.parseEther('0.005'),data}); console.log('用你真实地址模拟 createLaunch: ✅ 不 revert（合约逻辑没问题）') }
catch(e){ console.log('用你真实地址模拟: ❌ revert:', e.reason||e.shortMessage||e.message) }
