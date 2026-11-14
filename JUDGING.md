# 4lpha NEAR: judge brief

Evidence and links updated: 2026-11-14. Tracks: `defi`, `security`, `agents`.

[Visual judge guide](https://near.4lpha.tech/judge) · [Plain Markdown](https://near.4lpha.tech/judge.md) · [Repository and README](https://github.com/4lphaAI/4lpha-NEAR)

## Videos and agent pages

Start with the [main demo](https://youtu.be/LiskEYE7MjE). Strategy tutorials: [Grid Agent](https://youtu.be/oqsXoihV0O8), [LP Agent](https://youtu.be/1V9U_7v7kc4), [Schedule buy](https://youtu.be/DCbxlC-sVyQ), [Auto DCA](https://youtu.be/PIz6a1rvetw).

| Agent page | Funds | What to inspect |
| --- | --- | --- |
| [Grid Agent](https://near.4lpha.tech/account/ae5fa959-8148-485f-be55-29ea0c6ed157) | Real funds, NEAR mainnet | Current status, resting DCL orders, balances and activity. |
| [LP Agent](https://near.4lpha.tech/account/5c0fefa2-d820-4591-a625-be77dca4e61e) | Real funds, NEAR mainnet | Current liquidity position, range, balances and activity. |
| [Schedule buy](https://near.4lpha.tech/account/d43b9df5-e919-411f-a44a-9940b98e3a26) | Real funds, NEAR mainnet | Buying plan and recorded purchases. Stopped when checked on 2026-11-14. |
| [Auto DCA](https://near.4lpha.tech/account/5c51e35b-586d-44d6-b96b-c810ef7677ea) | Real funds, NEAR mainnet | Entry, DCA levels, holdings and activity. Read its page for the current status. |
| [Grid demo](https://near.4lpha.tech/demo/33a15c85-acee-46fe-8054-2ebb5031a54d) | Simulated funds | An existing simulation on live market reads, with no real transactions. |

These operator-supplied pages are public and read-only; inspecting them needs no wallet connection. Status can change, so read the current page rather than assuming an agent is still running. A page or tutorial is not proof that every lifecycle path has been tested.

## Product and NEAR scope

4lpha is a hosted DeFi agent marketplace on NEAR. A user deposits NEAR, sets limits and delegates a Grid, liquidity position or buying plan on Rhea Finance. Each live agent uses a separate OutLayer custody wallet. The user's NEAR account owns its policy on `outlayer.near`; the user retains control of policy updates and freeze.

Grid uses native Rhea DCL limit orders. LP manages concentrated liquidity on the same USDC/wNEAR pool. Schedule buy and Auto DCA use Rhea classic pools. NEAR AI can suggest an LP range inside a deterministic fence, and supplies the join decision for a separate paper-only meme.cooking agent. Model output has no payment tool.

The existing 4lpha visual shell predates the hackathon. The NEAR custody integration, owner checks, strategy execution, receipt verification, watchdog, simulation and NEAR UI wiring are the work to assess. The BNB Chain product is separate; its features and transactions are not evidence for this submission. Source boundaries and baseline disclosure are in the [README](https://github.com/4lphaAI/4lpha-NEAR#readme).

## 1. Reproduce without funds

Requirements: Node.js 22.22.2 or newer, npm and git. From a clean checkout, no wallet, API key or `.env.local` is needed for these checks. Dependency installation needs internet; the test suites and attack demo use offline fixtures.

```sh
git clone https://github.com/4lphaAI/4lpha-NEAR.git
cd 4lpha-NEAR
npm ci --ignore-scripts
npm run build
npm test
npm run attack-demo
```

Expected results:

- The build exits successfully.
- A successful `npm test` prints a core summary and a UI summary, both with zero failures. Record the actual tests / passed / skipped / failed numbers for the revision being checked.
- The attack demo exits with code 0 and ends with:

```text
Summary: 7 attacks, 7 stopped, 2 detected not prevented (tokens, and NEAR through wrapping, with a stolen key).
```

These commands do not start a live worker or submit a mainnet transaction. The operator-only live attack script is source evidence, not part of the reproduction commands.

## 2. Try the hosted simulation

1. Open [Grid](https://near.4lpha.tech/deploy/grid), [LP](https://near.4lpha.tech/deploy/lp), [Schedule buy](https://near.4lpha.tech/deploy/trade/schedule) or [Auto DCA](https://near.4lpha.tech/deploy/trade/dca). Select **Demo** in the Demo / Live switch.
2. Set the parameters and press **Start demo agent**. Expect an agent page at `/demo/<id>` stating: "Simulated agent. No wallet, no deposit, nothing is signed."
3. Inspect decisions, simulated actions, balances and the simulation limits. Find the agent again under **Demo agents (this browser)** on the Account page, or use **Stop** to end it.

Market reads are live; balances and fills are simulated. Fills need market movement. Schedule buy and Auto DCA may wait for about 30 minutes of recorded price history. Queue priority and exact execution costs are omitted; LP fees are estimates. The meme.cooking paper agent is separate and requires a NEAR wallet sign-in.

The [visual guide](https://near.4lpha.tech/judge#connect) explains the real hire sequence with sample accounts and balances. Its screenshots are illustrations, not mainnet proof.

## 3. Feature and evidence map

Recorded mainnet runs and their explorer links are in the [README evidence section](https://github.com/4lphaAI/4lpha-NEAR#mainnet-evidence). The statuses below describe recorded evidence, not simulated profit.

| Feature | Inspect implementation | Reproduce offline | Recorded status and limit |
| --- | --- | --- | --- |
| Grid | [src/core/grid.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/grid.ts) | [test/grid.test.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/grid.test.ts) | Mainnet: four orders, full fill, claim, reverse and reverse fill. That run exited through owner recovery tooling. The worker's Grid exit and freeze with resting orders are not yet recorded live. |
| LP | [src/core/lp.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/lp.ts) | [test/lp-v2.test.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/lp-v2.test.ts) | Mainnet: open, automatic rotation, freeze, unfreeze and worker exit. Compound, stop loss, take profit and an accepted AI range are not yet recorded live. |
| Schedule buy | [src/core/trade.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/trade.ts) | [test/trade.test.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/trade.test.ts) | Real-fund agent linked above for current status and receipts. Full lifecycle verification remains separate. |
| Auto DCA | [src/core/trade.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/trade.ts) | [test/trade.test.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/trade.test.ts) | Real-fund agent linked above, plus a strategy tutorial and simulation. The next-round restart is built; a second round has not yet been recorded on mainnet. |
| Paper meme agent | [src/core/meme-cycle.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/meme-cycle.ts) | [test/meme.test.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/meme.test.ts) | Live auction data, simulated participation. No custody wallet or real trade. |
| Policy before funding | [src/core/hire.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/hire.ts) | [test/hire.test.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/hire.test.ts) | Recorded hire, owner policy, freeze, signed resume and withdrawal. Funding requires verified policy ownership and confirmation that the recovery link was saved. |
| Receipt verification | [src/core/receipts.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/receipts.ts) | [test/receipts.test.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/receipts.test.ts) | Checks inner receipts and refunds; top-level success alone is insufficient. Unknown outcomes block new operations pending reconciliation. |
| Simulation isolation | [src/core/demo-sim.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/demo-sim.ts) | [test/demo.test.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/demo.test.ts) | Separate simulation store and execution path, without custody keys or signing. |

## 4. Security attack proof

### Offline attacks: reproducible application checks

`npm run attack-demo` feeds forged input to the product's own modules:

- **Three model-answer attacks:** an extra transfer instruction, plain-text prompt injection, and a well-formed range away from the price. The [LP range fence](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/lp-ai.ts) rejects each answer and uses a deterministic fallback.
- **Four destination attacks:** native transfer, `ft_transfer`, `ft_transfer_call` and `storage_deposit` targeting `attacker.near`. The [worker destination guard](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/evidence.ts) refuses all four. A control payment to the owner passes.

[Offline demo source](https://github.com/4lphaAI/4lpha-NEAR/blob/main/scripts/attack-demo.mjs) · [Regression test](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/attack-demo.test.ts)

These are forged answers and actions tested offline, not seven live theft attempts.

### Mainnet refusal: the agent's own custody key

On 2026-11-13, the operator used the real agent's custody API key to request **0.001 NEAR** to an existing account outside its whitelist. The policy was stored and the wallet was not frozen. Condensed recorded result:

```text
2026-11-13 06:52:58 UTC
Before: finalized block 224328453, balance 0.010985 NEAR
Response: HTTP 403 policy_denied
Reason: "Address '...' is not in whitelist"
After: finalized block 224328473, balance 0.010985 NEAR
Nothing moved. No transaction was created.
```

The refusal happened before signing, so it has no transaction hash. This is a recorded operator log, not a new request made by the offline demo.

[Recorded log](https://github.com/4lphaAI/4lpha-NEAR#attack-demo) · [Live probe source](https://github.com/4lphaAI/4lpha-NEAR/blob/main/scripts/attack-demo-live.mjs)

### Two paths detected, not prevented

With a stolen custody API key, an attacker can transfer tokens through `/wallet/v1/call`, or wrap NEAR and transfer the wNEAR. The policy does not inspect inner token recipients or amounts. The offline demo shows the [watchdog](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/watchdog.ts) detecting unexplained outflows after they happen. Alerts and an owner freeze cannot undo a loss. Seven blocked cases do not establish that every theft path is prevented.

## 5. Authority and remaining limits

- The user never gives 4lpha a key to their personal NEAR account. 4lpha holds the separate agent wallet's custody API key; OutLayer signs. This is hosted custody. OutLayer TEE attestation is not independently verified by this product.
- The policy limits direct native NEAR transfers and called contracts. The native cap is at most 0.25 NEAR per transaction; daily limits are best effort under concurrency. Only the owner can change the policy or freeze/unfreeze it.
- Freeze blocks new custody operations, including withdrawals. It does not remove existing DCL positions or cancel resting orders. Unfreeze leaves the job paused for the owner's signed Resume. Stop and withdraw pays NEAR plus the other token to the owner.
- Grid and LP use the pinned USDC/wNEAR DCL pool and DCL 2.4.2. A version mismatch stops automated DCL actions, including exit. Each needs 0.5 NEAR of non-withdrawable DCL registration outside the deposit.
- Watchdog alerts appear on the job page and in the operator log; there is no push notification. Small mainnet runs demonstrate mechanics, not returns.
- Lending is outside this submission. Privacy, independently verified inference, agent-to-agent payments and a NEAR AI Agent Market listing are not claimed.
- The main demo, four strategy videos and five agent pages (four real-fund runs and one simulation) are linked above. The separate security video and curated transaction slots on the visual guide still await links. Missing links are not additional evidence.
