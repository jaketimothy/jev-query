# nlsql-testbed

A Postgres test target for a zero-config NL→SQL composer. One schema, one deterministic seed, and 61 eval cases with verified gold SQL, all built around the irregularities a plug-and-play tool meets in real databases.

The domain is **Northpine Outfitters**, an outdoor-gear retailer: customers, orders, line items, payments, refunds, reviews, inventory snapshots, support tickets, and web sessions. Seventeen tables in schema `shop`.

## Quick start

```bash
createdb nlsql_test
psql -d nlsql_test -f schema.sql
python3 seed.py | psql -d nlsql_test -q          # ~12k orders, ~3 s to generate; ends with ANALYZE
pip install pyyaml
python3 eval/harness.py gold --db postgresql:///nlsql_test     # verifies all gold SQL, writes eval/expected.json
```

Score a composer run (one JSON line per case):

```bash
python3 eval/harness.py check --db postgresql:///nlsql_test results.jsonl
```

```json
{"id": "A01", "outcome": "execute", "sql": "SELECT count(*) FROM orders WHERE ..."}
{"id": "D02", "outcome": "clarify", "about": "join_path"}
{"id": "I01", "outcome": "decline"}
```

The run must use `as_of = 2026-10-05T00:00:00Z` (a Monday), UTC, ISO weeks, and calendar periods; `composer.yaml` sets these. `seed.py --scale 0.2` gives a smaller dataset, but `eval/expected.json` must then be regenerated with `harness.py gold`.

## Files

| Path | What |
|---|---|
| `schema.sql` | DDL. Comments on some tables and columns, none on others (on purpose). |
| `seed.py` | Deterministic generator (`--seed 42` default). Writes COPY blocks to stdout; no driver needed. |
| `composer.yaml` | Near-empty config: only the settings that make runs deterministic. |
| `eval/cases.yaml` | 61 cases: request, building blocks, acceptable outcomes, gold SQL, known-wrong SQL. |
| `eval/saved_fixtures.yaml` | Saved-query fixtures for the reuse cases (J02–J06). |
| `eval/harness.py` | `gold` verifies cases and writes `expected.json`; `check` scores a run and reports failing blocks. |
| `docs/nl-sql-composer-spec.md` | The composer spec (revision 2). |

## The traps, and the cases that catch them

Every trap was checked against the seeded data to make sure it changes the answer. A trap that doesn't change the result can't catch a bug.

| Trap | Where | Effect in this data | Cases |
|---|---|---|---|
| Fan-out | order totals joined to `order_items` | sum inflates 2.6× ($9.2M → $23.7M) | E01, G04 |
| Chasm | `order_items` and `payments` both under `orders` | line totals inflate 8% when joined through payments | E02 |
| Snapshot (semi-additive) | `inventory_snapshots` | summing across dates gives 6.5M units vs 218k actual | E05, E06 |
| Ambiguous join path | orders → regions via customer or via warehouse | 27.6% of orders differ | D01, D02, D03 |
| Role-playing FKs | billing vs shipping address; created-by vs assigned-to employee | Utah Q3: 97 shipped-to vs 102 billed-to | B01, D04, D05 |
| Soft delete | `customers.deleted_at` (98 closed accounts) | current-state counts must drop them; history must keep them | A04, A05, B08, F01, F05, H03 |
| `created_at` as event time | `customers` has no other timestamp | signup trends | A04, H03 |
| Multiple event timestamps | `orders.placed_at / shipped_at / delivered_at / cancelled_at` | "delivered in August" ≠ "placed in August" | B01, C04 |
| Duration pairs | `opened_at → first_response_at` | measure that exists only as a difference | C05 |
| Money in cents | every `*_cents` column | thresholds like "$500" must become 50000 | A02, B05, B09, F04 |
| Non-additive measures | `list_price_cents`, `rating`, `csat_score`, `discount_pct` | "total list price" must be masked | B05, E04, E07 |
| Missing FK constraints | `web_sessions.customer_id`, `converted_order_id` | joins only via name inference | D06, D08 |
| Junction table | `product_tags` | tag filters need EXISTS through the bridge | D07 |
| Self-reference / hierarchy | `categories.parent_id` | "Camping" has no products of its own; naive filter returns NULL | I02 |
| Value collision | region "West" vs 76 companies named "West…" | value linking must pick the region | B02, B03, F05 |
| Status vs related rows | `status = 'refunded'` (283) vs any refund row (855) | must ask | F06 |
| Values only in `pg_stats` | `brand`, `device_type`, `utm_source` have no constraint | value lists come from statistics | B10, E04 |
| Zero-row groups | South has no warehouse; 940 active customers never ordered; 28 products never sold | LEFT JOIN + COALESCE, NOT EXISTS | D03, F01, F02 |
| Nullable FK | anonymous sessions (68%), unassigned tickets | inner vs left join | B07, D08 |
| Business terms not in the schema | "revenue" | clarify once, then reuse the saved definition | J01–J06 |
| Out of v1 scope | JSONB attributes, formulas, hierarchies, writes | decline or clarify | I01–I05 |

## Case groups

| Group | Count | Covers |
|---|---|---|
| A | 6 | query shapes |
| B | 10 | filters |
| C | 5 | time windows |
| D | 8 | joins |
| E | 7 | aggregation traps |
| F | 6 | existence and HAVING |
| G | 5 | ranking |
| H | 3 | derived calculations |
| I | 5 | v1 boundaries |
| J | 6 | saved-query reuse |

Eight cases don't accept `execute` at all: four must clarify (D02, E07, F06, J01), two must decline (I01, I05), and two may decline or clarify (I03, I04). Another five accept either `execute` or `clarify`. A composer that executes everything can't pass, and neither can one that asks about everything.

## Seed data facts

| Table | Rows |
|---|---|
| customers | 3,200 (98 soft-deleted, 970 never ordered) |
| products | 360 (28 never sold, 44 never reviewed) |
| orders | 12,240 (Jan 2023 → Oct 4 2026; summer and holiday seasonality) |
| order_items | 23,572 (54% of orders have 2+ lines) |
| payments | 13,198 (failed attempts, gift-card splits, voids) |
| refunds | 855 (283 full, 572 partial) |
| inventory_snapshots | 36,747 (monthly) |
| support_tickets | 3,600 |
| web_sessions | 42,378 |

## Next steps for the testbed

- **Convention generalization.** Run the same composer with no `composer.yaml` against Pagila, Chinook and Northwind (Postgres ports) with a small hand-written case set each. Zero-config accuracy there matters more than accuracy here, since this schema was designed alongside the conventions.
- **Naming-style variants.** A script that renames this schema to Prisma style (`"createdAt"`, `"customerId"`, singular PascalCase tables) and re-runs the eval tests that the conventions aren't tied to Rails/Django naming.
- **Multi-tenant variant.** Add `account_id` to every table plus RLS policies to test C14.
