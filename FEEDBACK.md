# Uniswap Developer Feedback

Feedback from building **Plumb AI**, a natural-language DeFi interface, on the Uniswap
Trading API. Uniswap is the primary venue for both same-chain swaps and cross-chain
bridging in this app — not a fallback, and not one of several equal options.

Integration lives in [`src/lib/providers/uniswap.ts`](src/lib/providers/uniswap.ts).

Everything below came out of actually shipping against the API. Each point names the
file and line where we worked around it, so nothing here is hypothetical.

---

## Summary

**The Trading API is the best-priced routing surface we tested, and it was not close.**
We benchmarked it against LI.FI across every pair this app supports and Uniswap won
**13 of 14 routes**. The single most valuable and least advertised thing we found is that
`/quote` bridges as well as swaps — a quote with two different chain ids returns
`routing: BRIDGE`, which is Across underneath without an aggregator's margin stacked on
top. We came in expecting to use Uniswap for swaps and an aggregator for bridging, and
ended up using Uniswap for both.

The friction we hit was almost entirely **shape and consistency**, not capability:
inconsistent field names between endpoints, inconsistent encodings in responses, and a
unit convention that is easy to get wrong by a factor of 100. None of it blocked us. All
of it cost time that a more uniform contract would have saved.

---

## What worked well

### 1. `routing: BRIDGE` is the standout feature

Same endpoint, same request shape, two different chain ids, and you get a bridge quote
priced better than dedicated aggregators. Measured, real quotes:

| Route | Uniswap | LI.FI | Winner |
|---|---|---|---|
| USDC Arbitrum → Base | **0.9966** | 0.9941 (Across) | Uniswap |
| USDC Base → Arbitrum | 0.9929 | **0.9975** (Eco) | LI.FI |
| USDC Ethereum → Base | **0.9966** | 0.9941 (Across) | Uniswap |
| ETH Ethereum → Arbitrum | **0.009995** (2s) | 0.009975 (584s) | Uniswap |
| ETH Base → Ethereum | **0.009987** | 0.009963 | Uniswap |

The fill-time difference on ETH Ethereum → Arbitrum — **2 seconds versus 584** — is not a
rounding detail. It changes what you can build.

**Ask:** put this on the front page of the Trading API docs. We found it by passing
mismatched chain ids on a hunch. Teams that don't try that will integrate a separate
bridge aggregator they didn't need.

### 2. `check_approval` returning a `cancel` transaction

Handling USDT's non-zero-to-non-zero approval revert is a classic way to lose an
afternoon. The API returning an explicit `cancel` transaction alongside `approval` meant
we got it right without knowing the quirk existed. This is the API doing real work on the
integrator's behalf and it deserves more credit than it gets in the docs.

### 3. `estimatedFillTimeMs` on bridge quotes

We surface this directly on the confirmation card. Users care more about "when does this
land" than about the last basis point, and most bridge APIs make you guess.

---

## Friction, in the order it cost us time

### 1. `slippageTolerance` is a percentage, not basis points

```ts
// src/lib/providers/uniswap.ts:79
slippageTolerance: slippageBps / 100,
```

Our whole app carries slippage as basis points, as most DeFi tooling does. The API takes
a percentage number. `50` means 50%, not 0.5%. **A silent 100x error in the one parameter
that governs how much value a user can lose to slippage is the worst possible place for a
unit mismatch.**

**Ask:** either accept `slippageToleranceBps` as an alternative field, or reject values
above some sane ceiling (say 50) with an error naming the unit. Right now a fat-fingered
integration produces a quote, not an error.

### 2. `value` is decimal on swaps and 0x-hex on bridges

```ts
// src/lib/providers/uniswap.ts:154 — normalised at the boundary because of this
value: hexToDecimalString(tx.value ?? '0'),
```

Same field, same response type, two encodings depending on the routing. We only caught it
because a bridge test produced a wildly wrong native value. There is no signal in the
response telling you which encoding you got.

**Ask:** pick one. Hex is fine, decimal is fine — inconsistency between them is not.

### 3. `tokenInChainId` on `/quote`, `chainId` on `/check_approval`

```ts
// src/lib/providers/uniswap.ts:130
// Note the field is `chainId` here, not `tokenInChainId` as on /quote.
```

We left that comment in the source because we expect to trip over it again. Two endpoints
in the same API, same concept, different names.

### 4. Permit2 is opt-out, and opting out is undocumented

```ts
// src/lib/providers/uniswap.ts:54
'x-permit2-disabled': 'true',
```

Permit2 requires an EIP-712 signature collected *between* the quote and the swap call.
Plumb's execution model is a linear sequence of transactions the user signs in order,
with each receipt awaited before the next — inserting a typed-data signature mid-sequence
would have meant restructuring the executor.

We found `x-permit2-disabled` through trial and error. Without it, `/quote` returns
`permitData` and we have to reject the route outright:

```ts
// src/lib/providers/uniswap.ts:85
if (quoteBody.permitData) throw new ProviderError('Uniswap', '…requires a Permit2 signature…');
```

**Ask:** document the header. Better still, make the permit-free path a first-class
`routingPreference` rather than a header, so it's discoverable from the same place
integrators already look.

*(For what it's worth: we'd like to adopt Permit2 properly — the amount-and-deadline
scoping matches our "exact-amount approvals, never unlimited" policy better than plain
ERC-20 approvals do. A worked example of the quote → sign → swap sequence in the docs
would be the thing that gets us there.)*

### 5. Native assets are `address(0)` here and `0xEeee…` almost everywhere else

```ts
// src/lib/providers/uniswap.ts:63
const inToken = isNative(tokenIn) ? zeroAddress : tokenIn;
```

The `0xEeeeeEeee…EEeE` sentinel is the de-facto standard across aggregators. Supporting
both on input, and documenting which you emit, would remove a translation layer from every
multi-provider integration.

### 6. `routeString` is a routing-engine artefact, not displayable data

It embeds raw pool addresses. We want to show users *"Uniswap v3 · 0.05% pool"* on a
confirmation card, so we regex it:

```ts
// src/lib/providers/uniswap.ts:241
const version = routeString?.match(/\[(v\d)\]/i)?.[1]?.toLowerCase();
const feeTier = routeString?.match(/\[(\d+(?:\.\d+)?%)\]/)?.[1];
```

Parsing a display string with a regex is fragile and we know it — a format change breaks
us silently, and we'd render a worse label rather than an error.

**Ask:** a structured `route` array (`{ protocol, version, feeTier, tokenIn, tokenOut }`
per hop) alongside the string. Every consumer that shows a route to a human is writing
this same regex right now.

### 7. Bridges settle to the swapper only

```ts
// src/lib/providers/uniswap.ts:170
if (params.toAddress.toLowerCase() !== fromAddress.toLowerCase()) {
  throw new ProviderError('Uniswap', 'Bridging to a third-party address is not supported.');
}
```

This is the **one reason LI.FI is still in our stack.** A bridge quote has no recipient
field, so "bridge 500 USDC to Base and send it to alice.eth" has to leave Uniswap
entirely — and we route it away rather than silently misdirecting funds.

**Ask:** a `recipient` field on bridge quotes. Given how much better Uniswap prices these
routes, this single field would let us drop a dependency.

### 8. The quote object must be round-tripped verbatim

Sensible for integrity, and we're not asking for it to change — but it isn't stated
anywhere obvious, and the failure mode when you normalise or re-serialise the object is an
opaque rejection rather than "this quote was modified."

---

## Prioritised asks

| # | Ask | Why it matters |
|---|---|---|
| 1 | `recipient` on bridge quotes | Removes our only remaining reason to call another provider |
| 2 | Structured route data alongside `routeString` | Every UI integrator is writing the same brittle regex |
| 3 | Consistent `value` encoding | Silent wrong-native-amount bug with no detection signal |
| 4 | Reject or warn on out-of-range `slippageTolerance` | 100x unit error in the highest-stakes parameter |
| 5 | Document `x-permit2-disabled`; add a Permit2 worked example | We want to adopt Permit2 and this is what's stopping us |
| 6 | Promote `routing: BRIDGE` in the docs | Best feature in the API, effectively hidden |
| 7 | Accept the `0xEeee…` native sentinel | Removes a translation layer for multi-provider apps |
| 8 | Align `chainId` / `tokenInChainId` naming | Small, but it will keep catching people |

---

## Context

- **App:** Plumb AI — natural-language DeFi execution. Server builds transaction
  proposals; the user's wallet signs them. The server can never broadcast.
- **Chains:** Ethereum, Base, Arbitrum, Polygon.
- **Uniswap surface used:** `/quote`, `/swap`, `/check_approval`; `CLASSIC`, `WRAP`,
  `UNWRAP` and `BRIDGE` routing.
- **Fallbacks:** OpenOcean for swaps and LI.FI for bridges, used only when Uniswap
  declines a route — which, on price, it rarely should.
