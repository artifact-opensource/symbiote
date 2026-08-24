# AV Treasury & Artifact Virtual — Full Context (2026-06-27)

## Repositories
- **NEW**: `/home/adam/workspace/av_treasury/` — current production contracts (0.8.26, AGPL-3.0)
- **OLD**: `/home/adam/workspace/projects/artifact-virtual/token/` — legacy contracts (0.8.20, MIT)

## Contract Suite (v3)

### AuToken.sol (365 lines, UUPS upgradeable)
- Fixed supply: 1B Au, 9bps fee (50% burn, 50% treasury)
- Fees disabled by default, enabled via setFeesEnabled(true)
- Blocklist (ANTI_BOT_ROLE), sell cooldown (7 days), max tx 10%, max wallet 10%
- Flash mint with 9bps fee (fix from v2)
- 7-day upgrade timelock
- Deployed v2 on Base: 0x98D89c8DCEC01d5FD1EFE70989BCcc6031ABA77f

### TreasuryAMO.sol (740 lines, non-upgradeable)
- Buybacks of Au using reserve tokens (Aerodrome primary, Uniswap V2 backup)
- EXECUTOR_ROLE, PARAM_ROLE, DEFAULT_ADMIN_ROLE
- cooldown 24h, maxSlippage 0.5%, maxDeviation 5%, maxBuyback 5%/epoch
- MIN_BUYBACK_USD = 500
- TWAP validation, emergency pause/withdraw

### AgToken.sol (111 lines, UUPS upgradeable)
- MAX_SUPPLY 100M, governance, ERC20Votes + ERC20Permit
- MINTER_ROLE, BURNER_ROLE, UPGRADER_ROLE, 7-day timelock

### ArtifactTimelock.sol (86 lines)
- MIN_DELAY 48h, MAX_DELAY 30d, GRACE_PERIOD 14d
- Deployed v2: 0xB51542d460DBb4336F011CFF3Cbf80faeB3453f7

### TreasuryFlashBuy.sol (104 lines, MIT)
- Holds Ag, anyone can swap Ag→Au on DEX via buybackAu(agAmount, minAu)

## Deployment Addresses (Base Mainnet)
- AuToken v2: 0x98D89c8DCEC01d5FD1EFE70989BCcc6031ABA77f
- ArtifactTimelock v2: 0xB51542d460DBb4336F011CFF3Cbf80faeB3453f7
- User: 0xEc2b8EE9266E0C4540aa9ba2F6637640b019Fa7E
- CLPoolLauncher: 0xb9A1094D614c70B94C2CD7b4efc3A6adC6e6F4d3

## LP Mint Issue
- CLPoolLauncher has 6 whitelisted tokens. Au NOT whitelisted.
- 0xa3574ebc = InvalidPoolLauncherToken() when Au is tokenB
- When Au=tokenA, USDC=tokenB: passes whitelist, fails on USDC allowance=0
- Fix: approve USDC to launcher, call launch() with Au first, USDC second, tickSpacing=1

## Key Differences: Old → New
- License: MIT → AGPL-3.0, Solidity: 0.8.20 → 0.8.26
- Pattern: Direct → UUPS upgradeable (AuToken, AgToken)
- New in v3: 7-day timelock, blocklist, sell cooldown, max tx/wallet, flash mint fee fix
- Old TreasuryAMO: 363 lines, no TWAP, no emergency functions
- New TreasuryAMO: 740 lines, TWAP validation, forceApprove, emergency pause/withdraw

## LP Provisioning — Root Cause Found (2026-06-27)

### Problem:
User couldn't provision LP for AuToken on Aerodrome CLPoolLauncher.

### Root Cause:
AuToken (`0x98D89c8D...`) is NOT whitelisted in CLPoolLauncher (`0xb9A1094D...`).
The launcher's `launch()` function checks `isPairableToken()` for the poolLauncherToken.
Au is not in the whitelist → `InvalidPoolLauncherToken()` revert.

### Whitelisted tokens (6):
- USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
- WETH: 0x4200000000000000000000000000000000000006
- AERO: 0x940181a94A35A4569E4529A3CDfB74e38FD98631
- cbBTC: 0xcbB7C0000aB88B473b1f5aFd9ef808440eeD33BF
- SOL: 0x311935cD80B76769bF2EcC9D8aB7635B2139cf82
- ACES: 0x55337650856299363c496065c836b9c6e9de0367

### Fix:
User (owns CLPoolLauncher) calls `addPairableToken(0x98D89c8D...)` on the launcher.

### Additional Issue:
New deploy.js has wrong Aerodrome router: `0x4752bA5D...` has NO CODE.
Old/working router: `0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5`.
CLFactory: `0xade65c38cd4849adba595a4323a8c7ddfe89716a` (also owned by user)
Old Aerodrome factory: `0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a`
No Au pool exists at any tick spacing in either factory.
