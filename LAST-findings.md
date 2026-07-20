# `LASTvj…Qr9` — verified on-chain findings

Checked 2026-07-20 (read-only). The address is the payer/signer for NotArb
program `NA247a7YE9S3p9CdKmMyETx8TTwbSdVbVYHHxpnHTUV` calls.

## Execution result

The newest 2,000 finalized calls were fully checked. Every one logged `No
arbitrage profit found!`; none contained a DEX CPI or an owned-token balance
delta. Therefore those on-chain transactions succeeded only as no-profit
checks: there is no executed route or realized trade price to copy in this
verified window.

Latest representative call:

- signature: `2xRvK9tU5XEEvWEymP3QLMRPz1uN1LbiCEdMZxizsnNx6ZGcXFkWXdbCXBt7CrzASgra9AHiVzBh9UtFvR57xxFZ`
- slot: `434035768`
- time: 2026-07-20 12:57:38 CST
- fee / CU: 5,153 lamports / 91,541 CU

## Latest candidate route (not an executed trade)

| Component | Public key | Evidence |
| --- | --- | --- |
| Base assets | `So11111111111111111111111111111111111111112` (WSOL), `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC) | Passed as metas |
| Candidate token | `Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump` — Jimothy The Raccoon, 6 decimals | Passed as meta; target held 148.128648 |
| Raydium AMM v4 | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`; SOL/USDC pool `58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2` | Candidate program / pool account |
| PumpSwap | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`; Jimothy/SOL pool `5PGhKctym6odbHGo2tKMST2AjmJsb2uZBQrKkn4ZuFT5` | Candidate program / pool account |
| Meteora DLMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`; Jimothy/SOL pools `E3SotafntrgRg9XjppxqoJWSR4GUaJV7sA8u4a89rYo6`, `HsyX9wq8DN3N8Yc4vfAeceL7tofgPwnXtt2yBxQbs2xu`; Jimothy/USDC `87SEXDdgHm6cQ8k56bLZNTxYx4Y7LS8jN9VV3pxD5WWf` | Candidate program / pool accounts |

## Price

There was no fill, so no transaction execution price. The latest transaction's
post-balance reserve snapshot estimates:

- SOL/USDC: **76.575338 USDC per SOL**
- PumpSwap Jimothy/SOL: **0.000107419824 SOL per Jimothy**, about
  **$0.00822571 per Jimothy** at that same SOL/USDC spot

These are AMM reserve spot estimates before fees and slippage, not a quote or
fill. A separate public quote snapshot at 2026-07-20 14:57:36 CST put the two
deepest Jimothy/SOL pools at 0.0001033–0.0001038 SOL ($0.007821–$0.007854),
which illustrates why the timestamp must be kept separate.

## It is not pinned to one mint / DEX set

Another fully verified no-profit call,
`3ZMuXPpmG9Jv7uLKAwbybGGUpMomuxc4vQz8b22ysDrGaNVswAJz49AnqNnFAXqJPSteeA2GisrdFs2oJA9FRqDu`,
loaded WSOL, USDC, and `CREDBHvVqREBCAxMihzr8D1nepHMr2gmQoZWpmgGmeta`,
along with Raydium AMM, Meteora DLMM, Meteora CPMM, and Futarchy. This supports
the conclusion that the watched bot selects changing candidate market groups;
the latest Jimothy set should not be hard-coded as its only route.

The running watcher later captured another no-profit call at 2026-07-20
14:58:28 CST (`41g1nco1VG7Ahd3ZoXhzzLpjrrmkHFk4igQjWhpYRWdDfz94hBmffLkkgQoTELVjbdp3st96x4G6LGHgffXkUMv7`).
It switched to `9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump`
(The Black Bull / ANSEM), with Pump.fun AMM and Meteora DLMM as candidates,
and still logged `No arbitrage profit found!`. A public quote snapshot at
15:05:10 CST showed ~0.002583 SOL ($0.1953) on Meteora and ~0.002594 SOL
($0.1961) on PumpSwap. This is another candidate-price snapshot, not a fill.

## ALT and nonce

The three active public ALTs in the latest candidate call are imported in
`lookup-tables.txt` for NotArb's lookup-table loader:

- `GFcivC9XqVNS5pmEgZ8sgUL8b2JPbVyPYi5DzGBJPkZW` (256 entries)
- `9arKwzH776iKFoA2FKGJXmVsKK5m1T6AFM9bEZPtiPNi` (111 entries)
- `9NNTjz1VhdNew1BVwWnc5MD6sWP2V5THDqqerwocrohg` (250 entries)

No `AdvanceNonceAccount` instruction occurred in the recent 1,000-call window.
Do not copy guessed nonce accounts: every `[[nonce_pool]]` account must be
owned by the new bot wallet's `[user]` authority.
