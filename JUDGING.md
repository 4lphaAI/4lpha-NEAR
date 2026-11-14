# 4lpha NEAR: judge brief

Evidence and links updated: 2026-11-14. Tracks: **Unstoppable DeFi** (`defi`), **AI Security & Defense** (`security`), **Agent Economy** (`agents`).

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
| [LP demo](https://near.4lpha.tech/demo/6ef9ea5b-a192-4d8c-bbdd-6a5682bf626d) | Simulated funds | Price range, simulated liquidity and activity on live market reads. No real transactions. |

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
| Grid | [src/core/grid.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/grid.ts) | [test/grid.test.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/grid.test.ts) | README snapshot, 13 to 14 Nov: 0.90% step, 26 orders placed, 23 fills claimed and reversed in about 24 hours. Earlier owner-operated recovery is separate. Worker-managed exit, freeze with resting orders, stop loss and take profit remain unverified live. |
| LP | [src/core/lp.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/lp.ts) | [test/lp-v2.test.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/lp-v2.test.ts) | 13 Nov showcase: open and two rotations, then held at the two-per-24-hour limit. Separate 10 Nov verification: open, rotate, freeze/unfreeze and worker exit. Compound, stop loss, take profit and an accepted AI range remain unverified live. |
| Schedule buy | [src/core/trade.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/trade.ts) | [test/trade.test.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/trade.test.ts) | 13 Nov run: four 0.1 NEAR buys, four hours apart on pool 4512, then 1.395917 USDC and remaining NEAR paid to the owner. This covers the recorded USDC plan, not every pair or failure path. |
| Auto DCA | [src/core/trade.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/trade.ts) | [test/trade.test.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/trade.test.ts) | 14 Nov: 0.1 NEAR base buy into USDC on pool 4512. Configured with three levels at 0.5% steps and 0.7% take profit; those settings do not prove level fills. The next-round restart is built; a second round remains unverified live. |
| Paper meme agent | [src/core/meme-cycle.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/meme-cycle.ts) | [test/meme.test.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/meme.test.ts) | Live auction data, simulated participation. No custody wallet or real trade. |
| Policy before funding | [src/core/hire.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/hire.ts) | [test/hire.test.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/hire.test.ts) | Recorded hire, owner policy, freeze, signed resume and withdrawal. Funding requires verified policy ownership and confirmation that the recovery link was saved. |
| Receipt verification | [src/core/receipts.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/receipts.ts) | [test/receipts.test.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/receipts.test.ts) | Checks inner receipts and refunds; top-level success alone is insufficient. Unknown outcomes block new operations pending reconciliation. |
| Simulation isolation | [src/core/demo-sim.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/src/core/demo-sim.ts) | [test/demo.test.ts](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/demo.test.ts) | Separate simulation store and execution path, without custody keys or signing. |

### Mainnet transaction trails

These are the README's recorded transactions, grouped by run. Snapshot counts above are historical observations. A successful transaction only supports the action it records; inspect all receipt outcomes. All links below open NearBlocks.

| Run | What to verify | Receipts |
| --- | --- | --- |
| Grid showcase, 13 to 14 Nov | Order placement, payout claim and reverse order | [Place order](https://nearblocks.io/txns/DucP2AeZsFkJztVwZhHZmiua4sYABDSy4AtXHfqi7bBv) · [Claim](https://nearblocks.io/txns/AZ7EBoegX6rhNk4qnscyXRspMyYwiit4BsjnieoawPnM) · [Reverse](https://nearblocks.io/txns/4nGqV5sY1SfRt3aGBYN2JNLbHVYUQcdLnHcTEVFfyCSR) |
| Earlier Grid recovery | Owner-operated DCL recovery and token payout, not the worker's own Grid exit | [Claim](https://nearblocks.io/txns/3Yy4UXMAyN6aCVnBc3DPrYH34Fwvrh37ejK8Z1r8PHWN) · [USDC to owner](https://nearblocks.io/txns/FuHTgXiKBwDMHnR1y4nCnNZnaVLFJ8WnBTqd6iYwux4s) |
| LP showcase, 13 Nov | Opening the position and removing/reopening it twice | [Open](https://nearblocks.io/txns/4fsLDwzSFunY5BwcVkkkSmP1dcEeUK59Zt6ipWfEZ5qp) · [Remove 1](https://nearblocks.io/txns/57DURJQ5vHyms6mFqgz7rrwkcMaPxQT8FoFoN3WpoVKZ) · [Reopen 1](https://nearblocks.io/txns/61MC5x7N8nR5HgK5ATF2vDxZv4TW1ghGciRa2dydC1fo) · [Remove 2](https://nearblocks.io/txns/G5FqoBfbJ2EcuCVe9CUJREMzdA6R2ZeWVVCNS5MtMN2E) · [Reopen 2](https://nearblocks.io/txns/5PpWzDqjQAGM2peVXQHzb3cXjshvBCHSYqgqdYza6mdH) |
| Earlier LP verification, 10 Nov | Owner freeze/unfreeze and the worker's removal and payout | [Open](https://nearblocks.io/txns/4hKfZeuh7BjwsRnnMiUcBBkP4V5mxypCtQobHZuBrFZ7) · [Freeze](https://nearblocks.io/txns/5Y8SnukgJdfzBa1P6KUDvVouFyKwm6GyMFVg76swz6hg) · [Unfreeze](https://nearblocks.io/txns/A38PwYNXveQgQmT7CrSLzPvpKdgpVPCsjRRKCW33nq7X) · [Remove on exit](https://nearblocks.io/txns/4Ai7XWNiWYknf3XZbefrRms8dAozkqyK1exyxfTxGTeZ) · [USDC to owner](https://nearblocks.io/txns/9KDHuAfxkzvg4S77t39KFXKfmMWb6HfNUvZu2Qzs1tJx) |
| Schedule buy, 13 Nov | Timed purchases and payout after the plan finished | [Buy 1](https://nearblocks.io/txns/DYdjbkPSiARsGaSJuvJaVswdg5mReBgywYThg9cRYtEL) · [Buy 4](https://nearblocks.io/txns/9dX8i1mvZZeuhCYTrmSJkfUAv78kvZS34yqkXcyMNyC9) · [USDC payout](https://nearblocks.io/txns/38f9fjtBR4tBYLhkx4mwcdb9PxHxqXSMwxhrLzbDDjad) |
| Auto DCA, 14 Nov | The initial 0.1 NEAR buy, not a completed second round | [Base buy](https://nearblocks.io/txns/6CGuHNn8VdtL3EwsNWuhNuAj4NKQAUDkuoEUMyf2cQX2) |
| Policy ownership verification | The user's policy-storage transaction | [Store policy](https://nearblocks.io/txns/s5a3JtKPJLdV9E2b42jpZoM4Pg54y79wH33PpLwVEim) |
| Separate core exit verification | Transfers returning funds to the owner | [Withdrawal 1](https://nearblocks.io/txns/D1gwobL3advvV7XnehQDQPzq1dksWKhCTDaeLAvGThPe) · [Withdrawal 2](https://nearblocks.io/txns/2B4zCQgkzjK6NfdD6Y6onJ1eFDGi2ubGVK8aZTVQuc4N) |
| Custody-wallet swap probe | Swap into USDC, forced slippage refund, swap back to NEAR | [Swap in](https://nearblocks.io/txns/Dta33qXP9r2pwrokJunjf6QbkoueohzmVtpTiC8KpKws) · [Refund](https://nearblocks.io/txns/3LfecsNjnt5MQ8f9kSYAkocuFNHn5ZJmrDFLUrtCPeUZ) · [Swap out](https://nearblocks.io/txns/CxA3XmvRS8VzDLV5sGG438Pbsnrb2yUpK5UAcXEEdiWz) |
| Third-party receipt example | A successful top-level status with an inner failed/refunded DCL swap; not a 4lpha trade | [Transaction](https://nearblocks.io/txns/2kGmQmnP2qL1QfvmoY36Yo7ApSQh5vEFbtUehEAPv7Ko) |
| Same-key recovery probe | Original token registration. Re-sending its key returned the original request in an API reply, creating no second request | [Original registration](https://nearblocks.io/txns/3NhUNWfPjhYLfATTHorBjGWjz28NUDXniXrCpLyNUG5p) |

The recovery probe covers storage-deposit. Equivalent re-send behavior on `/call`, `/transfer` and a still-processing request remains unproven. See [operations tests](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/ops.test.ts) and [receipt tests](https://github.com/4lphaAI/4lpha-NEAR/blob/main/test/receipts.test.ts) for offline coverage.

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
- The main demo, four strategy videos, six agent pages and the transaction trails above are linked for inspection. Simulation pages and illustrative screenshots do not count as mainnet execution evidence.
