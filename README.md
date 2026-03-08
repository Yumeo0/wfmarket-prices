# wfmarket-prices

This repository contains a daily snapshot of Warframe Market item top orders.

## What it does

- Fetches all items from `https://api.warframe.market/v2/items`
- Fetches top orders for each item from `/v2/orders/item/{slug}/top`
- Stores top 5 `buy` and `sell` orders per item in `data/warframe-market-prices.json`
- Enforces request pacing at or below `3 requests/second`

## Run locally

```bash
bun scripts/fetch-warframe-market-prices.ts
```

You can also run it with:

```bash
bun run fetch:prices
```

## Automation

GitHub Actions workflow:

- File: `.github/workflows/daily-warframe-market-prices.yml`
- Schedule: daily at `02:00 UTC`
- Also supports manual trigger via `workflow_dispatch`
