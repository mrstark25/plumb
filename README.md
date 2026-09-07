# Plumb

**Find true, on-chain.**

A chat box that executes on-chain. Say what you want in plain English — *"swap 0.1 ETH to USDC on Base"*, *"bridge 500 USDC from Arbitrum to Base"*, *"where can I get the best yield if I have $1000?"* — and Plumb prices it, explains the trade-offs, and hands your wallet a transaction to sign.

**Plumb never holds your keys.** The server builds transaction proposals; your browser wallet signs them.

---

## What it does

| Intent | How it's served |
|---|---|
| Transfers | Direct ETH and ERC-20 sends, with ENS resolution |
| Same-chain swaps | Uniswap Trading API, with OpenOcean as a no-signup fallback |
| Cross-chain bridging | Uniswap Trading API (`routing: BRIDGE`), with LI.FI as the coverage fallback |
| Yield questions | DefiLlama live pool data, filtered for size and sustainability |
| Earning on deposits | Morpho vaults — deposit and withdraw directly, ERC-4626 |
| Prices | CoinGecko free tier, with DefiLlama as a full-fidelity fallback (price + 24h) |
| Leveraged perps | Hyperliquid — long/short with leverage, optional builder code |
| Prediction markets | Polymarket odds (read-only — see below) |
| Portfolio | Holdings, Morpho / Sky / Aave positions, 24h move — one panel |
| Buying with fiat | Privy on-ramp, 49 currencies — matched before the model, zero tokens |
| Balance questions | Direct on-chain reads via viem |
| Everything else DeFi | Groq-hosted Llama 3.3, grounded in the tools above |

Supported chains: **Ethereum, Base, Arbitrum, Polygon, Robinhood Chain**.

Robinhood Chain (4663) is supported narrowly and deliberately. Bridging to and
from it works, balances and prices resolve, and Multicall3 is deployed so reads
still batch — but **no swap venue this app can reach quotes it**, so a swap
there is refused with that reason rather than failing three calls deep. There
is also no canonical USDC, USDT or DAI on the chain yet, and its bridged token
list already carries two different contracts both called `USDG`, so the
registry holds only ETH, WETH, LINK and USDe — each with symbol and decimals
read from chain 4663 before being written down. Aave, Morpho and Sky are not
deployed there and are skipped rather than called.

## Uniswap integration

Uniswap is the **primary venue for both same-chain swaps and cross-chain bridging** here,
not a fallback among equals. Everything that touches the Trading API:

| File | Role |
|---|---|
| [`src/lib/providers/uniswap.ts`](src/lib/providers/uniswap.ts) | The whole integration — `/quote`, `/swap`, `/check_approval`; `CLASSIC`, `WRAP`, `UNWRAP` and `BRIDGE` routing |
| [`src/lib/agent/handlers/swap.ts`](src/lib/agent/handlers/swap.ts) | Same-chain swap intent → Uniswap quote → `TxProposal` |
| [`src/lib/agent/handlers/bridge.ts`](src/lib/agent/handlers/bridge.ts) | Cross-chain intent → Uniswap `routing: BRIDGE`, LI.FI only on decline |
| [`src/lib/providers/swap-types.ts`](src/lib/providers/swap-types.ts) · [`bridge-types.ts`](src/lib/providers/bridge-types.ts) | The provider-neutral shapes every route is normalised into |
| [`src/components/tx/TxProposalCard.tsx`](src/components/tx/TxProposalCard.tsx) | Where a Uniswap quote becomes something a user signs |

**Why Uniswap is first:** benchmarked against LI.FI on every pair this app supports, the
Trading API priced better on **13 of 14 routes** — including bridges, where
`routing: BRIDGE` is Across underneath without an aggregator's margin. The measurements,
along with eight pieces of concrete API feedback from building this, are in
[`FEEDBACK.md`](FEEDBACK.md).

## Wallets

Two backends behind one interface (`WalletSession`), chosen at the root:

- **Privy** when `NEXT_PUBLIC_PRIVY_APP_ID` is set — browser extensions, WalletConnect, plus email / Google / passkey login with an embedded wallet created for users who arrive without one.
- **Direct EIP-6963 discovery** otherwise — browser extensions only.

Whatever the user connects with is exposed as a standard EIP-1193 provider that viem wraps exactly as it wraps MetaMask, so the executor and every card are unaware of which backend is in play. Adding a third would mean one more adapter and nothing else.

Three things worth knowing:

- **A failing Privy never takes the app down.** It throws during render on an invalid app id, and a throw inside a provider unmounts everything below it — chat, prices, yields, history, none of which need a wallet. An error boundary catches that and drops back to browser-wallet discovery, so a misconfiguration or an outage costs the login options and nothing else. Verified by booting with a deliberately invalid id.
- **Privy is loaded lazily.** Its SDK bundles connectors for every wallet it supports and is by far the heaviest dependency here — it took first load from 294 KB to 856 KB gzipped, well past the 300 KB budget. Code-splitting it puts the greeting, history and composer on screen immediately and brings the connect button live a moment later.
- **The CSP widens only when Privy is configured.** An injected-only deployment keeps `frame-src 'none'` and the narrow `connect-src`.

### What Privy does that a bare provider cannot

The adapter above keeps the executor and every card unaware of which backend is
in play — that is deliberate, and it stays true. But two things are genuinely
Privy-only, and pretending otherwise would mean shipping a worse product to the
users who need the most help. They live behind a `privy` capability object on
`WalletSession`, checked for presence exactly as `injected` already is.

**Funding, because an embedded wallet starts empty.** A user who signs in with
an email or a Google account gets a wallet created for them and immediately has
nothing to transact with. Every other path into this app quietly assumes the
user already had assets somewhere else. Privy's funding flow — card, exchange,
or a transfer from another wallet — is the only thing that closes that gap, and
without it the first action of a brand-new user is to leave. The button targets
the active chain's **USDC**, because `destination.asset` wants a concrete token
address and every one in our registry is hand-verified; guessing a native
sentinel is the kind of thing this app refuses to do everywhere else.

**Sending, but only for embedded wallets.** An embedded wallet has no extension
to raise a confirmation, so Privy renders one itself and manages nonce and gas.
An external wallet connected *through* Privy is the opposite case: the user
expects MetaMask's confirmation screen, and swapping in an unfamiliar one on the
single screen that must never surprise anyone would be a regression. That
decision is one pure function, [`planPrivySend`](src/lib/wallet-session.ts), so
it is tested rather than assumed.

| File | Role |
|---|---|
| [`src/app/privy-provider.tsx`](src/app/privy-provider.tsx) | Provider config, login methods, lazy-loaded |
| [`src/hooks/usePrivyWallet.ts`](src/hooks/usePrivyWallet.ts) | `useSendTransaction`, `useAddFunds`, session → `WalletSession` |
| [`src/lib/wallet-session.ts`](src/lib/wallet-session.ts) | `PrivyCapabilities`, `planPrivySend`, `planDisconnect`, `isFundingExit` |
| [`src/components/wallet/ConnectButton.tsx`](src/components/wallet/ConnectButton.tsx) | The funding entry point |
| [`src/hooks/useTxExecutor.ts`](src/hooks/useTxExecutor.ts) | Chooses the Privy send path when one exists |

**The flow this unlocks, end to end, with no extension installed:** sign in with
Google → Privy creates an embedded wallet → *Add funds* → *"swap $50 to USDC on
Base"* → *"deposit it in the best Morpho vault"*. Transfers, swaps, bridging and
ERC-4626 vault deposits all run over that same wallet. No seed phrase is ever
shown, because there is never one to show.

## Quick start

```bash
npm install
cp .env.example .env.local     # add GROQ_API_KEY (free: console.groq.com/keys)
npm run dev                    # http://localhost:3000
```

`GROQ_API_KEY` is the only required variable. Everything else is optional:

| Variable | Required | Effect if unset |
|---|---|---|
| `GROQ_API_KEY` | **yes** | The agent cannot run |
| — | — | *Free tier: 8,000 tokens/min and 200,000/day. Heavy testing exhausts the daily cap; raise it at [console.groq.com/settings/billing](https://console.groq.com/settings/billing).* |
| `GROQ_MODEL` | no | Defaults to `openai/gpt-oss-120b`. Groq retires hosted models periodically — if chat starts failing with "no longer served", pick a current id from [console.groq.com/docs/models](https://console.groq.com/docs/models) |
| `UNISWAP_API_KEY` | no | Swaps route through OpenOcean instead. Free key at [developers.uniswap.org](https://developers.uniswap.org/dashboard) |
| `LIFI_API_KEY` | no | Bridging still works; only raises rate limits |
| `COINGECKO_API_KEY` | no | Prices still work, but the keyless tier is a few calls/min and rate-limits readily. A free Demo key from [coingecko.com](https://www.coingecko.com/en/developers/dashboard) raises it substantially |
| `RPC_URL_1` / `_8453` / `_42161` | no | Falls back to public RPCs, which are rate-limited |

> Set your own RPC endpoints before any serious use. The public defaults will throttle balance reads under load.

## How a swap actually flows

```
"swap 0.1 ETH to USDC on Base"
        │
        ▼
  POST /api/chat ──► Groq decides: build_swap(chain, fromToken, toToken, amount)
        │
        ▼
  Server: resolve tokens ──► check balance ──► quote ──► check allowance
        │
        ▼
  TxProposal { steps: [approve?, swap], warnings, minReceived, expiresAt }
        │
        ▼
  Browser renders a confirmation card ──► user signs each step in their wallet
```

The server's last act is producing calldata. It cannot broadcast anything.

### Prediction markets (Polymarket)

Live odds from the public Gamma API — implied probability, volume, close date and whether a market is actually accepting orders. No key, nothing on-chain.

Two data quirks are handled at the boundary: `outcomes`, `outcomePrices` and `clobTokenIds` arrive as **JSON-encoded strings rather than arrays**, and `active` means *listed*, not *tradeable* — orders can be paused on a live market, so that is reported separately.

**Trading is not wired up, and that is a real blocker rather than a shortcut.** Polymarket cut over to CLOB V2 in April 2026 (new domain version, new exchange contract, an eleven-field order struct with `expiration` in the request body but *not* in the signed payload). Three things stand in the way:

- **Collateral is pUSD**, a 1:1 USDC wrapper at `0xC011a7E1…82DFB` — verified on-chain — not USDC.e. Trading means wrapping through Polymarket's on-ramp first, then four separate approvals (two ERC-20, two ERC-1155, across the standard and neg-risk exchanges).
- **Direct EOA trading appears to be allowlist-gated.** Polymarket's own docs say to use an EOA "if your EOA is allowlisted", with no documented way to request it. Accounts created from an external wallet are Safe Wallets (`signatureType: 2`), and Privy embedded wallets are Deposit Wallets (`signatureType: 3`) needing ERC-7739 signature wrapping.
- **The CLOB's L2 API secret is a bearer credential** that can place and cancel orders for an address. Putting it in browser JS exposes it to any XSS, so it belongs server-side — which is a different trust model from everything else here.

### Buying with fiat

Ask for it in plain English — *"buy USDC with INR"*, *"buy 5000 rupees of USDC"*,
*"add funds"* — and a funding card opens Privy's on-ramp. Before this the agent
refused outright and sent people to a centralised exchange, which is a strange
thing for a wallet app to do when the wallet it just created for you is empty.

**It costs no model tokens.** This was briefly a ninth tool, and on a free Groq
key that was the wrong shape. Every tool schema is resent on every round of
every request, so one more pushed two back-to-back exchanges past the
8,000-token minute — a permanent tax on every message, to serve a request most
people make once. Nothing about a fiat purchase needs a language model: there
is no price to fetch, no route to choose and nothing to reason about. So it is
matched deterministically in `detectFundingIntent` before the model is called,
and the request never reaches Groq. The reply is written in code. It answers in
about half a second, where the tool took several.

The matcher is deliberately narrow, because the failure that matters is
mistaking a **swap** for a purchase:

| Asked | Result |
|---|---|
| `buy USDC with INR` | Funding card, INR |
| `buy 5000 rupees of USDC` | Funding card, INR, ₹5000 prefilled |
| `add funds` / `top up` / `pay with card` | Funding card |
| `buy ETH with USDC` | **Falls through** — that is a swap |
| `buy $500 of USDC` | **Falls through** — dollars are how this app prices everything, so it reads as much like a dollar-sized trade |

A buy verb alone never triggers it; it needs a buy verb *and* real fiat, and
USDC is not fiat. Anything it does not confidently recognise goes to the model
exactly as before, which is the safe direction to fail in.

**The rate is live, and labelled as market.** An early version let the model
answer conversion questions from memory and it said "≈ ₹83 per $1" when the
real figure was ₹94.60 — a 12% error on the number someone uses to decide how
much to buy, which would have shown 60.24 USDC for ₹5,000 instead of 52.85.
The cause was the familiar one: the prompt already said *ground every rate in
a tool call*, but nothing priced fiat, so the rule had no way to be obeyed and
the model filled the gap. The card now prices the asset **directly against the
currency** through CoinGecko — no dollar hop — for the 39 of the on-ramp's 49
currencies CoinGecko covers. The other ten show no rate at all. It is labelled
market rate and says outright that the provider's quote adds a fee and spread,
because a market rate shown without that reads as a promise of what you will
receive.

Three more things hold on this path:

- **The currency is validated, not passed through.** Privy accepts 49 fiat
  currencies; the list is runtime data taken from the SDK's own union. An
  unsupported code is **named on the card** rather than quietly falling back to
  dollars — discovering your currency is unavailable inside a payment sheet is
  worse than being told before it opens.
- **The card is a button, never an automatic open.** The server produces a plan;
  the browser opens the sheet only when the user clicks it.
- **It promises a flow, not an outcome.** Which providers and currencies appear
  depends on the user's country and on Privy's dashboard configuration, neither
  of which is knowable from the server — so the card says so.

The old *Add funds* button in the header is gone. It could only ever mean "USDC
on the current chain", which is not what anyone was actually asking for.

### Portfolio

One panel for the whole account: wallet balances across all four chains, Morpho
vault positions, Sky savings, and Aave v3 borrowing. Everything is a live read —
balances and Aave from the chain, Morpho positions from its indexer, prices from
CoinGecko with DefiLlama behind it.

**There is no profit-and-loss figure, and that is a decision rather than an
omission.** PnL needs a cost basis — what was paid and when — which needs
transaction history. Plumb has no account system and no indexer behind it, so
that history does not exist here. What it can measure honestly, it does: the 24h
move on priced holdings, current APY per position, and projected annual yield at
today's rates. The panel says all of this in plain words rather than leaving a
blank space that reads as "flat".

Four things worth knowing if you touch this code:

- **A 24h change is measured against yesterday's value, not today's.** $110 after
  a 10% rise moved $10, not $11. Multiplying the current value by the percentage
  overstates every gain and understates every loss by the size of the move —
  a bug that shipped into `totalsFor` and was caught by the test that pins it.
- **The 24h percentage is taken over only the holdings that carry one.** Spread
  across the whole portfolio instead, one moving asset among many would report a
  calm day that did not happen.
- **Dust is dropped, counted, and disclosed.** A real address checked during
  development held 27 Morpho positions, most worth under a cent. They are
  excluded from the table *and* from the totals — hiding a row while still
  counting it produces a panel whose numbers do not add up.
- **An unpriced holding is never treated as dust or as zero.** Not knowing a
  value is a different thing from knowing it is negligible, and both are
  different from it being nothing.

Protocol notes, each verified on-chain rather than taken from a doc page:

| | |
|---|---|
| **Aave v3** | Pool addresses confirmed by calling `getReservesList()` and walking `ADDRESSES_PROVIDER() → getPriceOracle()`. Account totals are in the oracle's base currency, `BASE_CURRENCY_UNIT` = 1e8 on all four chains. **An account with no debt returns `type(uint256).max` as its health factor** — rendered as "No debt", never as a 78-digit number. |
| **Morpho** | Position figures live under `state`, not on the position itself; querying `shares` directly is a validation error rather than an empty result. The API returns amounts as **a number for small values and a decimal string for large ones, in the same response** — parsing either as one type silently drops positions. |
| **Sky** | sUSDS on Ethereum is a real ERC-4626 over USDS, so the same reader the Morpho vaults use works unchanged. **The Base deployment is not**: it answers `symbol()` and `decimals()` and nothing else — no `asset()`, no `convertToAssets()`. Probed directly. It is carried as an ordinary token holding, never as a savings position. |
| **Sky rate** | The Sky Savings Rate is a per-second rate in ray (1e27) and is **compounded, not multiplied** — simple multiplication reports ~3.46% where the real figure is ~3.52%. |

Health factor is the loudest thing on the Aave card, for the same reason the
liquidation price is the loudest thing on a perps card: below 1.00 the position
is liquidated. The card colours at 1.5 and again at 1.1, and says which it is.

### Leveraged perps (Hyperliquid)

Perps settle on **HyperCore**, Hyperliquid's order-book L1 — not HyperEVM, and not any EVM chain. Trading requires USDC deposited into Hyperliquid; a wallet balance cannot be used, and the handler says so explicitly rather than reporting "no funds".

**This is the one feature the user's wallet cannot sign.** L1 actions must be signed under EIP-712 domain `chainId: 1337`, and MetaMask refuses typed data whose domain chainId is not the active chain. Hyperliquid's answer — and its own front-end's design — is an **agent key**:

| | |
|---|---|
| Generated | In the browser, on wallet connect |
| Stored | That browser's `localStorage`, never transmitted |
| Can | Place, modify and cancel orders; change leverage |
| **Cannot** | **Withdraw, transfer, or move funds anywhere** |
| Authorised | Once, by a signature from the user's real wallet |

So the app still never holds keys on the server, but a private key does sit in browser storage — a real and different exposure from a hardware wallet, and the authorisation step says so before the user opts in.

Signing correctness is not assumed. `test/hyperliquid-sign.test.ts` reproduces the official SDK's `connectionId` vector and three full signature vectors (mainnet, testnet, and a real order action). If the msgpack encoding, byte layout, or field order ever drift, those fail — and a wrong action hash means every order is silently rejected. **Action key order is load-bearing**: the action is msgpack-encoded before hashing, so reordering a field invalidates the signature.

Tick and lot rules are enforced before an order is built — five significant figures, per-asset decimal caps, integers exempt, sizes always rounded **down**. An off-tick price is rejected outright by the exchange.

Liquidation is the loudest thing on the card. It is computed with Hyperliquid's documented formula and labelled an estimate, because it ignores fees and funding; the exchange's authoritative figure appears once the position is open. At 20x a 2.4% move liquidates, and the card says exactly that.

**Builder codes** are optional. Set `HYPERLIQUID_BUILDER_ADDRESS` to a registered builder and orders carry the code plus a one-time fee approval; leave it blank and no builder code is attached. Fees are tenths of a basis point, capped at 100 (0.1%) on perps.

### Transfers

A plain send: native ETH goes straight to the recipient with empty calldata, an ERC-20 calls `transfer(to, amount)` on the token. No approval, no router, one signature. ENS names resolve on mainnet regardless of the sending chain, and the card shows the **resolved address in full, never truncated** — a name is a claim, the address is what actually receives, and an address the reader cannot check character by character is one they cannot check at all.

This is the only irreversible action in the app, so it refuses more than it builds:

| Refused | Why |
|---|---|
| The zero address | Anything sent there is burned |
| The token's own contract | Tokens sent there are almost always unrecoverable |
| Your own wallet | Costs gas, achieves nothing |
| More than the balance | Would simply revert |
| A native send that leaves no gas | Produces a transaction that cannot pay for itself |
| An unresolvable ENS name or malformed address | Never guessed at |

It warns when the recipient is a contract, which may not handle incoming tokens, and always warns that the send cannot be undone.

Two presentation details: the "destination is not your wallet" alarm that fires on a swap or bridge is **suppressed here** — sending elsewhere is the entire intent, and an alarm on every transfer would train people to ignore it. And a transfer has no quote, so the card shows no minimum-received, no slippage, and no countdown; inventing zeros for those would imply precision that does not exist.

### Prices

Spot prices, 24h change and market cap come from CoinGecko's free tier, which needs no key. Two details are handled at the boundary:

- **Symbols resolve from a vetted map, never a search.** Dozens of tokens share a ticker, and a search would happily return a scam coin's price for "USDC" — the same reasoning that stops the app guessing a contract address from a symbol.
- **A rate limit slows an answer down, it does not remove it.** The keyless tier 429s readily, so a failure falls back to DefiLlama, which prices the same assets by their CoinGecko id — the identity mapping is shared, only the transport differs. The card names which source actually answered.
- **The fallback carries 24h movement too.** It used not to, and that was a quiet hole rather than a cosmetic one: the portfolio panel reads its headline 24h figure from this call, so a CoinGecko 429 did not merely change the source — it emptied the number, with nothing visibly failing. DefiLlama's own `/percentage` endpoint is now fetched alongside the price, in parallel, and a failure there costs the change but never the price. Market cap it genuinely does not serve, and that stays unknown rather than being approximated.
- **DefiLlama's confidence score is enforced.** It scores every price it serves, and a thin or stale market scores low. Below 0.8 the price is treated as unknown rather than displayed — the same rule as everywhere else here, where a figure nobody can stand behind is worse than a blank.
- **The portfolio uses the same fallback chain.** It called CoinGecko directly until this landed, so one 429 took out every price *and* every 24h figure on the panel at once.

Contract-level pricing (the USD figures on swap and deposit cards) goes through the same pair, CoinGecko first. Note CoinGecko lower-cases contract addresses in its response keys, which is easy to miss.

### Morpho vaults

Deposits go straight to the vault: a plain ERC-4626 `approve` + `deposit(assets, receiver)`. No router, no bundler, and shares are minted to the depositor's own address. Exits use `redeem(shares, ...)` rather than `withdraw(assets, ...)` — redeeming shares the user actually holds cannot revert on a share-price move between quote and signature, and it leaves no dust behind.

Vault discovery is Morpho's GraphQL API (no key). Three things there are easy to get wrong, and all three are handled at the boundary:

- **V1 and V2 are separate query roots** (`vaults` and `vaultV2s`) with different response shapes and no version field — the root you call *is* the discriminator. Plumb queries both and merges, because the highest-yielding vaults are frequently V2.
- **`netApy` is a fraction, not a percent** (`0.0442` = 4.42%), and it is already net of the vault fee. Subtracting the fee again would understate every rate.
- **Vaults V2 always return `0` from `maxDeposit()`** — the standard's `max*` functions are stubbed. Gating capacity on `maxDeposit < amount` silently rejects every V2 deposit; `previewDeposit()` is the real signal and works on both.

A deposit can name a vault instead of addressing it. Refusing a name used to
send the agent back to the user asking for a `0x` address — for a vault it had
listed by name a moment earlier, which is an unanswerable question for most
people and stalled the deposit entirely. Matching by name is no weaker than
matching by address: both resolve against the listed set, so an unlisted or
invented vault is still refused, and an ambiguous prefix is refused rather than
guessed. The name is a lookup key, never a contract.

**A withdrawal is never gated on the curated list.** `findVaultByAddress` only
returns vaults Morpho marks `listed: true` and that clear a TVL floor, which is
exactly right for a deposit — it is what stops this app putting money into an
unvetted vault. Applied to an exit it does the opposite of protecting anyone: a
vault that is delisted, shrinks below the floor, or drops out of the indexer
would leave a real position permanently unwithdrawable through Plumb. Getting
money out is always safe, so an exit falls back to reading the vault straight
off the chain. A withdrawal also needs neither an address nor a chain — the
wallet's own positions say which vaults it is in and where, and a named vault
is searched on every chain because the model fills `chain` from whatever the
wallet happens to be connected to, which is a guess rather than a statement.

Only `listed: true` vaults are surfaced, with Morpho's own RED risk warnings filtered out — anyone can deploy a vault, and an unfiltered APY sort is dominated by test deployments holding a few dollars. A vault named by address is verified against that same listed set before Plumb will build a deposit.

Share tokens use 18 decimals regardless of the underlying asset, so decimals are always read from the vault rather than assumed.

### Why Uniswap bridges, and why LI.FI is still here

Uniswap's Trading API bridges as well as swaps — a quote with two different chain ids comes back as `routing: BRIDGE`, which is Across underneath, quoted without an aggregator's margin on top. Measured across every pair this app supports, it prices better on **13 of 14** routes:

| Route | Uniswap | LI.FI |
|---|---|---|
| USDC Arbitrum → Base | **0.9966** | 0.9941 (Across) |
| USDC Base → Arbitrum | 0.9929 | **0.9975** (Eco) |
| USDC Ethereum → Base | **0.9966** | 0.9941 (Across) |
| ETH Ethereum → Arbitrum | **0.009995** (2s) | 0.009975 (584s) |
| ETH Base → Ethereum | **0.009987** | 0.009963 |

So Uniswap is tried first. LI.FI is the fallback and earns its place on coverage, not price — it routes assets and pairs Uniswap does not, it aggregates bridges Uniswap cannot reach (that one Base → Arbitrum win is Eco), and it is **the only one of the two that can send to a third-party address**. Uniswap's bridge always settles to the sender, so a request naming a different recipient is refused there and routed to LI.FI rather than silently misdirected.

Without `UNISWAP_API_KEY`, bridging uses LI.FI for everything and still works.

### Layout and history

A sidebar-and-conversation layout: history on the left grouped by recency (Today / Yesterday / Previous 7 days / Older), the transcript on the right. A new chat opens on a time-aware greeting with the composer directly beneath it; once there is a transcript the composer drops to the foot and docks.

**History lives in `localStorage`, on the device only.** There is no account system and no database here, so conversations are never uploaded, never synced across devices, and are lost if site data is cleared — the sidebar says so rather than implying otherwise. The store is capped at 40 conversations because transaction calldata is bulky, and every read and write is wrapped: a private window, a cleared store, a quota error, or data written by an older version all degrade to an empty list rather than breaking the session.

Two details worth knowing if you touch this code:

- **The active conversation id is mirrored in a ref.** An in-flight reply appends its answer through a callback captured before the conversation existed; reading React state there sees `null` and starts a second, empty conversation.
- **The conversation id is generated outside the state updater.** React may invoke an updater more than once with the same input, so a `crypto.randomUUID()` call inside it mints a different id per invocation and leaves a duplicate behind. Both of these produced real phantom rows before they were fixed.

The greeting opens on an animated capability line — **"Plumb can —"** followed by a phrase that assembles letter by letter on a stagger, then cycles: *swap tokens on any chain*, *bridge in a single signature*, *earn yield through Morpho*, *find where the best rate is*, *explain what the risk really is*. Each phrase names a real capability backed by a tool, so the animation doubles as documentation of what the agent can actually do.

Three things keep it honest:

- **Only `opacity` and `transform` animate**, so the whole effect stays on the compositor.
- **Under `prefers-reduced-motion` it holds a single phrase and stops rotating**, with letters at full opacity rather than stuck at the animation's starting `opacity: 0`.
- **Screen readers get the full list as ordinary prose.** The animated copy is split into per-letter elements, which assistive technology would otherwise announce one character at a time, so it is `aria-hidden` with a visually-hidden sentence alongside.

`npm run shots` asserts all three: that every phrase cycles, that reduced motion holds still and stays visible, and that the greeting block shares one left edge.

## Design decisions worth knowing

- **Contract reads are multicall-batched.** A single proposal needs balance, allowance, and four ERC-4626 views; un-batched, that is enough to rate-limit a shared public RPC on its own.
- **Replies render as real markup, safely.** `Prose.tsx` parses the Markdown the model actually emits — headings, lists, **tables**, bold, inline code — into React elements. It is not a Markdown library and never touches `dangerouslySetInnerHTML`: model output is untrusted, and building elements directly makes HTML injection structurally impossible. Tables get mono uppercase headers and right-aligned numeric columns so a model-authored comparison reads like the component-rendered ones, and they scroll inside their own container so the page never scrolls sideways.
- **Exact-amount approvals, never unlimited.** A stale infinite allowance to a compromised router is one of the most common ways users lose funds. USDT's non-zero-to-non-zero revert is handled with an explicit reset step.
- **The request payload is kept on a token budget.** Groq's free tier allows 8,000 tokens per minute *and* 200,000 per day, and the system prompt plus all seven tool schemas are resent on every round of every request. That fixed overhead is ~1,600 tokens, history sent to the model is capped at the last 10 messages, replies are capped at 400 tokens, and tool rounds at 3 — so a worst-case request stays inside a single minute's budget. `test/payload-size.test.ts` asserts those ceilings, so adding a tool or a paragraph of guidance fails a test rather than quietly making the app unusable on a free key.
- **Per-minute and per-day limits are reported differently.** A per-minute limit clears in seconds and is automatically waited out once; a per-day limit means the key is finished until it resets, so it fails fast and says so rather than sending the user to retry in seconds.
- **The whole exchange is capped at 90 seconds**, and each model call at 45. The Groq SDK's default is a 10-minute timeout with retries, which once turned a single stuck request into a 12.8-minute wait with no way for the user to cancel.
- **Quotes expire after two minutes.** Long enough to read the card, short enough that the price cannot drift far. The executor refuses to sign an expired proposal.
- **Slippage is clamped to 0.1%–5%** regardless of what the model asks for.
- **A bridge recipient is validated, checksummed, and shown as an alert** whenever it is not the connected wallet. Text arriving from outside — an on-chain token symbol, a DefiLlama pool name — is stripped of newlines and instruction punctuation before it re-enters the model's context, because that is the path a prompt injection would take to redirect funds.
- **Unknown token symbols are refused, not guessed.** Give a contract address and it is verified on-chain (symbol and decimals are read, not trusted) before quoting. Guessing an address for a ticker is how people swap into impostor tokens.
- **Yield defaults filter out the noise.** Unfiltered, the top of any APY list is sub-$100k pools printing four-digit numbers nobody can actually enter. Minimum TVL and a maximum plausible APY scale with the stated risk tolerance.
- **The model never quotes an APY from memory.** Every yield claim is grounded in a live `find_yield` call.

## Layout and history

A sidebar-and-conversation layout: history on the left grouped by recency (Today / Yesterday / Previous 7 days / Older), the transcript on the right. A new chat opens on a time-aware greeting with the composer directly beneath it; once there is a transcript the composer drops to the foot and docks.

**History lives in `localStorage`, on the device only.** There is no account system and no database here, so conversations are never uploaded, never synced across devices, and are lost if site data is cleared — the sidebar says so rather than implying otherwise. The store is capped at 40 conversations because transaction calldata is bulky, and every read and write is wrapped: a private window, a cleared store, a quota error, or data written by an older version all degrade to an empty list rather than breaking the session.

Two details worth knowing if you touch this code:

- **The active conversation id is mirrored in a ref.** An in-flight reply appends its answer through a callback captured before the conversation existed; reading React state there sees `null` and starts a second, empty conversation.
- **The conversation id is generated outside the state updater.** React may invoke an updater more than once with the same input, so a `crypto.randomUUID()` call inside it mints a different id per invocation and leaves a duplicate behind. Both of these produced real phantom rows before they were fixed.

The greeting opens on an animated capability line — **"Plumb can —"** followed by a phrase that assembles letter by letter on a stagger, then cycles: *swap tokens on any chain*, *bridge in a single signature*, *earn yield through Morpho*, *find where the best rate is*, *explain what the risk really is*. Each phrase names a real capability backed by a tool, so the animation doubles as documentation of what the agent can actually do.

Three things keep it honest:

- **Only `opacity` and `transform` animate**, so the whole effect stays on the compositor.
- **Under `prefers-reduced-motion` it holds a single phrase and stops rotating**, with letters at full opacity rather than stuck at the animation's starting `opacity: 0`.
- **Screen readers get the full list as ordinary prose.** The animated copy is split into per-letter elements, which assistive technology would otherwise announce one character at a time, so it is `aria-hidden` with a visually-hidden sentence alongside.

`npm run shots` asserts all three: that every phrase cycles, that reduced motion holds still and stays visible, and that the greeting block shares one left edge.

## Design

Built on the LCX DeFi design system, taken from `defi.lcx.com`'s own token block rather than approximated:

- **`#f7f7f7` paper, `#0a0a0a` ink, LCX Blue `#2b6bff` as the only accent.** The defining choice is restraint with the brand colour — the primary action is near-black, and blue is rationed for links, focus rings, hover glows and micro-labels. A wall of blue reads as crypto exuberance; withholding it reads as an institution.
- **Geist + Geist Mono.** Display type squeezes to `-0.03em`; mono eyebrows open to `0.16em` uppercase. Every figure is tabular so columns align and values don't jitter as they update.
- **Hairlines over shadows.** 1px borders at 8–12% black do the structural work; elevation stays at 7–16% alpha in a navy-black `#060a18`. Hover turns the hairline brand-blue and lifts 3px.
- **Density is the one deliberate departure.** The marketing site breathes at 112px section rhythm; this is a working instrument and is tightened accordingly.

`npm run shots` captures 320/768/1024/1440 plus the transaction card with a live quote, and fails the run on any console error or horizontal overflow.

## Commands

```bash
npm run dev            # dev server
npm run build          # production build
npm run typecheck      # tsc --noEmit
npm test               # unit tests (317, 85% statement coverage)
npm run test:coverage  # with coverage
npm run smoke          # live check against all four upstream APIs
npm run shots          # visual check at 4 breakpoints (needs `npm run dev` running)
```

`npm run smoke` is the one to run when swaps or bridges start failing for no obvious reason — it asserts that the exact request shapes the providers build still return the exact fields they read.

## Layout

```
src/
├── app/
│   ├── api/chat/route.ts      validation, rate limiting, agent entry
│   └── page.tsx
├── components/
│   ├── chat/                  shell, sidebar, greeting, message list, composer
│   ├── tx/TxProposalCard.tsx  the confirmation card — the real UI of this app
│   ├── yield/YieldTable.tsx
│   ├── wallet/                EIP-6963 connect
│   └── ui/Prose.tsx           markdown → React elements, no innerHTML
├── hooks/
│   ├── useConversations.ts    local history: create, select, delete, persist
│   ├── useWallet.ts           connect, chain switching, account tracking
│   ├── useTxExecutor.ts       sequential signing, receipt waiting
│   └── useChat.ts
├── lib/
│   ├── agent/
│   │   ├── tools.ts           tool schemas exposed to the model
│   │   ├── system-prompt.ts   behaviour, tone, and hard rules
│   │   ├── runner.ts          tool-calling loop
│   │   └── handlers/          swap, bridge, yield, portfolio
│   ├── providers/             uniswap, openocean, lifi, defillama, prices
│   ├── chains.ts  tokens.ts  erc20.ts  erc4626.ts  format.ts
│   ├── conversations.ts       history storage, titling, recency grouping
└── styles/tokens.css          design tokens
```

## Limits

- **Analysis, not financial advice.** Plumb explains where a yield comes from and what can go wrong. It will not tell you how much to allocate.
- **No transaction tracking after signing.** Bridge status can be polled via LI.FI, but the UI does not yet follow a transfer to its destination chain.
- **Rate limiting is in-memory, which serverless largely defeats.** On Vercel each invocation may be a fresh instance, so the limiter becomes a speed bump rather than a guarantee. A public deployment backed by a metered Groq key wants Deployment Protection, an auth gate, or a shared store (Upstash Redis) in front of it.
- **Rate limiting is in-memory and, by default, a single shared bucket.** Set `TRUST_PROXY_HEADERS=true` to key it per client IP — but only when deployed behind a proxy that overwrites `X-Forwarded-For`, or callers can mint a fresh bucket per request. Move it to Redis before scaling out.
- **The token registry is deliberately small.** Adding tokens means adding verified addresses to `src/lib/tokens.ts`, not loosening symbol resolution.
