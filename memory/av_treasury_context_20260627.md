# AV Treasury Context - June 27 2026

## Key Addresses
- **Treasury Safe**: `0x1082C9467488F869Aa64fcb0Dc78CD9BC6319F9e` (2-of-2: dev wallet `0xEc2b8E...` + Binance `0x88dB13...`)
- **CLPoolLauncher**: `0xb9A1094D614c70B94C2CD7b4efc3A6adC6e6F4d3`
- **CLPoolLauncher Owner Safe**: `0xE6A41fE61E7a1996B59d508661e3F524d6A32075` (7-of-7 EOA multisig — NOT the Treasury Safe)
- **AuToken (Au)**: `0x98D89c8DCEC01d5FD1EFE70989BCcc6031ABA77f`
- **Dev Wallet**: `0xEc2b8EE9266E0C4540aa9ba2F6637640b019Fa7E` (private key in .env)
- **Deployer**: `0x21E914dFBB137F7fEC896F11bC8BAd6BCCDB147B` (private key in .env)

## Pending Task: Add AuToken as Pairable Token
- Need to call `addPairableToken(0x98D89c8DCEC01d5FD1EFE70989BCcc6031ABA77f)` on CLPoolLauncher
- Calldata: `0x25a4666e00000000000000000000000098d89c8dcec01d5fd1efe70989bccc6031aba77f`
- Only the CLPoolLauncher Owner Safe (`0xE6A41f...`) can call this
- Treasury Safe does NOT own the CLPoolLauncher (common point of confusion)
- Dev wallet has ~0.0029 ETH on Base

## CLPoolLauncher Owner Safe Owners (all EOAs)
1. 0x3cc42a196321994e637156851A0b247034983E46
2. 0x0EbEE8c53c228a5fC1EbBA05F179Bd99f577Cb52
3. 0x9939578305136e255151F3cc1c0996368F7221ba
4. 0x3e4ee5e1FCc58aCbAEf449A7f2fE52BA7ba71d4c
5. 0xc6E5084b11eE98da7bDBc4F9cabf5E17bb209652
6. 0x3c15f0Ac6c0DC75906A4977f8b7b25cab667Afe2
7. 0x0aEDA6FdC0A8277FF4646a6aA60eFa61D8D741aC

## .env Location
`/home/adam/workspace/av_treasury/.env`
