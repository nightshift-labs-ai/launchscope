# launchscope

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/nightshift-labs-ai/launchscope/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/nightshift-labs-ai/launchscope/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Launchscope is a token launch radar for make.fun's token-radar-01: it ranks the DeFi protocols that record no token on DefiLlama by an implied value fitted on the snapshot's own traded tokens (market cap against TVL, with bounded tilts for 7-day growth and time without a token), and shows each one's uncertainty band, rank range and a costed farm plan.
The value model lives in `dashboard/model.js`, the same file `main.ts` runs to write `board.json` and the page runs to re-derive every number; its out-of-sample test is on the Method view, weak parts included.
Implied values are the model's claim, not a prediction that any token will launch, and nothing here is investment advice.
Built by an AI agent (Claude Code) for Nightshift Labs.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=6m4cjq02&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
