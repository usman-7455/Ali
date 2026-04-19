# HieraCost — Hierarchical Cost & Inventory Management

> Track costs, weights, sales, and profits across a full Truck → Lot → Item → Subitem hierarchy.

[![Live App](https://img.shields.io/badge/Live%20App-HieraCost-5ed3a8?style=flat-square&logo=vercel)](https://hieracost.vercel.app/)

---

## What it does

HieraCost is a client-side inventory and cost management system built for businesses that deal in physical goods sold by weight. It tracks a four-level hierarchy — Trucks containing Lots, Lots containing Items, Items containing Subitems — with full cost rollup, weight tracking, sale recording, and profit reporting at every level.

---

## Live Demo

**[hieracost.vercel.app →](https://hieracost.vercel.app/)**

---

## Features

**Cost Management** — Initial costs and processing records (labour fees) aggregate upward through the hierarchy. Lot-level costs roll up from all children automatically.

**Weight Tracking** — Set weight capacities at lot and item level. Track sold vs. remaining weight per entity, with depletion detection.

**Sales System** — Record sales by weight with per-kg or total pricing. Support for partial payments, multiple payment installments, and pending balance tracking.

**Profit Reports** — Calculate net profit scoped to any Truck, Lot, Item, Customer, or Mill. Toggle between including or excluding pending payments.

**Mills & Customers** — Link lots to mills, assign sales to customers, and view pending balances per customer.

**Backup & Restore** — Export your full database as a JSON file and restore it at any time.

**Offline-first** — All data is stored locally in IndexedDB. No server, no account required.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla HTML, CSS, JavaScript |
| Storage | IndexedDB (browser-native) |
| Fonts | Space Mono, DM Sans (Google Fonts) |
| Deployment | Vercel |

No frameworks. No dependencies. No build step.

---

## Data Model

```
Truck
└── Lot (initial_cost, total_weight, mill)
    └── Item (initial_cost, total_weight, processing_records)
        └── Subitem (initial_cost, total_weight, processing_records)
```

Cost propagation: `total_cost = initial_cost + sum(all processing labour fees)`

Weight ratio is applied to `total_cost` only when calculating proportional profit on partial weight sales.

---

## Run Locally

```bash
git clone https://github.com/your-username/hieracost
cd hieracost

# No install needed — just open the file
open index.html

# Or serve with any static server
npx serve .
```

---

## Project Structure

```
hieracost/
├── index.html     # App shell and view templates
├── style.css      # Full design system (dark industrial theme)
├── app.js         # All logic: DB, calculations, UI, events
└── README.md
```

---

## Changelog

**v1.5** — Bug fixes only
- `calculate_profit`: weight ratio now applied to `total_cost` only; `initial_cost` isolated
- Lot profit: removed double-counting from spurious `pairs.unshift()` 
- `addItem` / `addSubitem`: zero `initial_cost` and zero `total_weight` no longer block adding entities
- `sellEntity`: `lot.sold_weight` now only updated by item-level sales, preventing subitem double-count

---

## Author

Built by **Usman** — feel free to fork or open issues.
