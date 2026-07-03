import { ethers } from 'ethers'
const p = new ethers.JsonRpcProvider('https://bsc-dataseed.bnbchain.org')
const LF='0xB5AF6387ed653F3f15C01Da4031571Fd454DF22f', NFTF='0x5542FD41EcD84090Db760Dc9cc73e5A15dd6DAbf'
const ME='0x688b63F94dda23986aa5CD1398D4b2c052888Dc0', Z=ethers.ZeroAddress
// 读工厂 tokenImpl
const tokenImpl = await new ethers.Contract(LF,['function tokenImpl() view returns (address)'],p).tokenImpl()
console.log('tokenImpl:', tokenImpl)
// 复刻前端 mineVanity 挖真实靓号 salt（aaaa 后缀 + avoidReserved）
const PREFIX='3d602d80600a3d3981f3363d3d373d3d3d363d73', SUFFIX='5af43d82803e903d91602b57fd5bf3'
const bytecodeHash = ethers.keccak256('0x'+PREFIX+tokenImpl.slice(2).toLowerCase()+SUFFIX)
const effSalt=(creator,salt)=>ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address','bytes32'],[creator,salt]))
let salt, predicted
for(let i=0;;i++){
  const s=ethers.toBeHex(BigInt('0x9999')+BigInt(i),32)
  const a=ethers.getCreate2Address(LF,effSalt(ME,s),bytecodeHash).toLowerCase()
  if(a.endsWith('aaaa')){ if(a[a.length-5]==='a')continue; salt=s; predicted=a; break }
}
console.log('挖到真实靓号 salt:', salt)
console.log('predicted 地址:', predicted, predicted.endsWith('aaaa')?'(aaaa 后缀 ✓)':'')
console.log('该地址已有合约?', (await p.getCode(predicted))!=='0x' ? '⚠️ 是（地址被占→CREATE2 会 revert!）':'否')
// 模拟 createLaunch 用真实 salt
const clFrag={"type":"function","name":"createLaunch","stateMutability":"payable","inputs":[{"name":"cfg","type":"tuple","components":[{"name":"name","type":"string"},{"name":"symbol","type":"string"},{"name":"totalSupply","type":"uint256"},{"name":"mintCount","type":"uint256"},{"name":"unitPriceBNB","type":"uint256"},{"name":"buyTaxBps","type":"uint16"},{"name":"sellTaxBps","type":"uint16"},{"name":"bucketVaultBps","type":"uint16"},{"name":"bucketMarketingBps","type":"uint16"},{"name":"bucketLiquidityBps","type":"uint16"},{"name":"bucketDividendBps","type":"uint16"},{"name":"bucketBurnBps","type":"uint16"},{"name":"marketingWallet","type":"address"},{"name":"quoteToken","type":"address"},{"name":"airdropEnabled","type":"bool"},{"name":"airdropCount","type":"uint8"},{"name":"dividendToken","type":"address"},{"name":"minimumShareBalance","type":"uint256"}]},{"name":"vaultFactory","type":"address"},{"name":"vaultData","type":"bytes"},{"name":"salt","type":"bytes32"}],"outputs":[]}
const iface=new ethers.Interface([clFrag])
const vaultData=ethers.AbiCoder.defaultAbiCoder().encode(['tuple(string,string,uint256,uint256,uint256,uint16,uint16,string)'],[['LABUBU','LABUBU',300n,300n,ethers.parseEther('2000'),90,10,'ipfs://bafybeifrv77itkwm5jlay6ubdu6nx7bw4rp4ksseei57p3dbydsuu2sp7i/']])
const cfg=['LABUBU','LABUBU',ethers.parseEther('1000000'),200n,ethers.parseEther('0.01'),300,300,8000,0,500,0,1500,ME,Z,false,0,Z,0n]
const data=iface.encodeFunctionData('createLaunch',[cfg,NFTF,vaultData,salt])
try{ const g=await p.estimateGas({to:LF,from:ME,value:ethers.parseEther('0.005'),data}); console.log('用真实 salt estimateGas:', g.toString(),'→ ✅ 能成') }
catch(e){ console.log('用真实 salt 模拟: ❌ REVERT:', e.reason||e.shortMessage||e.info?.error?.message||e.message) }
