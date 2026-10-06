# NL → SQL Structured Composer
### Building blocks, Postgres syntax, and Jev question map (v1 target: PostgreSQL)

*Revision 2: zero-config conventions + `composer.yaml` + saved query library replace the curated catalog and metric catalog (§2, §2B). Test target: `nlsql-testbed` (§10).*

---

## 0. The core idea

The model never writes SQL. The composer works in three layers that never mix:

| Layer | Owns | Implemented by |
|---|---|---|
| **Grammar** | What is legal: clause structure, which aggregates apply to which types, which operators apply to which columns, join validity, fan-out safety | Code |
| **Schema model** | What exists: tables, columns, keys, roles, units, known values, relationships, plus business definitions learned from accepted queries | Introspection + conventions, optional `composer.yaml`, saved query library (§2, §2B) |
| **Intent** | What the user meant: which of the legal, existing options matches the request | Jev (Choice / Score / Noul) |

Code enumerates the legal next moves of a typed **QueryPlan**; Jev assigns calibrated probabilities to those moves; code assembles the plan, validates it, and compiles it to parameterized Postgres. Correctness then comes from three places:

1. **By construction**: syntax, identifiers, types, join paths, and literals cannot be invalid because nothing is free-generated.
2. **Calibrated semantics**: every decision carries a probability distribution, so the runner-up is visible.
3. **Gating**: low-confidence decisions become clarifying questions built from the top options, instead of silent wrong answers.

```
NL request
  │
  ├─[code] normalize; extract spans (numbers, quoted strings, proper nouns, date/relative-time phrases)
  ├─[code] value linking: spans → (column, value) candidates via pg_trgm / FTS over a value index
  ├─[code] schema retrieval: BM25 / embeddings over the schema model → top-K tables + columns
  ├─[code+Jev] R0 saved-plan match (§2B): reuse an accepted plan and rebind its slots
  ▼
R1 [Jev] broad speculative fan-out: shape, feature flags, subject, measures, dimensions,
         span roles, filter polarity, time period, operators   (one request, ~40–150 questions)
  ▼
  [code] masked joint decoding → required tables → FK graph → candidate join trees
R2 [Jev] dependent decisions: join-path ambiguity, HAVING target, sort key, date column,
         re-asks of low-margin Choices with rotated options      (one request, ~5–30 questions)
  ▼
  [code] assemble QueryPlan → validate → fan-out check → compile to SQL + params
R3 [Jev] verification: span coverage + plan-narrative agreement   (one request)
  ▼
gate ─► execute (read-only role, statement_timeout)
     ─► clarify (question generated from runner-up options)
     ─► decline (unsupported shape / write request)
```

Three Jev round trips per query in the common case, each a single batched request.

---

## 1. Jev properties that shape this design

From the TypeSafe docs (jev-1.13):

| Property | Design consequence |
|---|---|
| Three primitives: **Choice** (≤255 options, returns `choice`, `probabilities`, `confidence`), **Score** (2–10 ordered levels, returns `score`, `probabilities`, `confidence`), **Noul** (yes probability, no `confidence`) | Every SQL decision is cast as pick-one, pick-a-level, or yes/no over code-enumerated candidates. |
| Questions in one request are evaluated **independently**; dependent questions need a second request | Organize decisions into rounds by true data dependency; ask speculatively within a round. |
| **Not a generator** | Every literal is either a span copied from the request or a known value of a column (enum label, CHECK list, or `pg_stats` common value). Jev only selects. |
| Weak at **math, counting, numeric precision** | All arithmetic, date math, limits, and thresholds are computed in code. Jev only decides *which* span plays *which* role. |
| Weak at **date comparison** | Relative-time phrases map to a closed library of period definitions; code computes bounds. Explicit dates use date-part Choices. |
| **Literal reading** | Instructions state the exact condition; criteria carry boundary cases ("more than" vs "at least"). |
| **Indirection** hurts | Ask about the request directly ("does the request split results by X?"), never about properties of properties. |
| **Large irrelevant state** hurts | Shared `state` is only the request + a pruned slice of the schema model. Candidate-specific metadata goes in a structured `instructions` object. |
| **Choice option-order bias** (leans to first option) | Rotate options when the top-2 margin is small; average the two distributions. |
| Choice ≤ 255 options | Hierarchical selection (table → column) or per-candidate Nouls for large schemas. |

### Two composition patterns used throughout

**Masked joint decoding.** When a decision has several independent parts (column × aggregate, span × column × operator), ask each part as its own question in the same request, then combine in code:

```
P(col, agg) ∝ P(col) · P(agg) · legal(col, agg)
```

`legal()` is the grammar mask (e.g. `sum` is illegal on a text column; `sum` on a non-additive measure like `unit_price` is illegal). This is an independence approximation, but it keeps everything in one round and guarantees the result is legal.

**Assignment over slots.** When spans or candidates must be used at most once (a number can be a LIMIT *or* a threshold, not both), build the span × role probability matrix and solve with the Hungarian algorithm, with a `none` slack column per span. Per-span argmax can double-assign; assignment cannot.

---

## 2. Schema model: conventions first, config to override, saved queries to learn

The composer is an open-source library you drop into an app and point at a database. It has to work with zero setup, get better with a short config file, and learn an organization's business definitions from use rather than from a catalog someone writes up front. Three sources build the **schema model** Jev reads, in increasing precedence:

1. **Introspection + conventions** (automatic, §2.1–2.3)
2. **`composer.yaml`** (optional overrides, §2.4)
3. **Saved query library** (grows as users accept queries, §2B)

Introspection writes a generated **`composer.lock.json`**: every table and column with its inferred role, unit, display column, relationships with cardinality, known values, and the rule and confidence behind each inference. It is reviewable like a lockfile, regenerated when the schema fingerprint changes, and diffable in code review.

### 2.1 What introspection reads (read-only, no table scans by default)

| Source | Gives |
|---|---|
| `pg_attribute` / `information_schema.columns` | names, types, nullability, defaults, generated columns |
| `pg_constraint` | primary keys, foreign keys, UNIQUE, CHECK (parses `IN (…)` lists and `BETWEEN` ranges) |
| `pg_enum` | enum labels |
| `pg_description` | `COMMENT ON` text for tables and columns |
| `pg_stats` | `n_distinct`, `null_frac`, `most_common_vals`, `avg_width`: value lists and cardinality without scanning |
| `pg_class.reltuples` | row estimates (fact vs. dimension heuristics) |
| `pg_views`, `pg_matviews` | views, which have no constraints and fall back to name inference |
| `pg_class.relrowsecurity` | whether RLS is on, so tenancy is left to the database |

If `pg_stats` is empty (no `ANALYZE` yet, or the role can't see stats), an opt-in fallback samples with `TABLESAMPLE SYSTEM (1)`.

### 2.2 Convention rules

Rules are ordered; the first match wins. Each produces `(role, confidence, rule_id)` in the lockfile. The testbed (§10) has at least one table that exercises each rule.

**Relationships**

| Rule | Detects | Example (testbed) |
|---|---|---|
| R1 | FK constraint → relationship; a UNIQUE FK column means 1:1, otherwise N:1 | `orders.customer_id → customers` |
| R2 | No constraint, column named `<table>_id` or `<role>_<table>_id` (singular or plural match), type equals the target PK → inferred relationship, medium confidence | `web_sessions.converted_order_id → orders` |
| R3 | Junction: two FKs that form the PK or a UNIQUE, and otherwise only audit columns → bridge, traversed as many-to-many, never a subject | `product_tags` |
| R4 | Self-reference → hierarchy (recorded; recursive traversal is v2) | `categories.parent_id` |
| R5 | Role-playing: two or more relationships to the same target → each labeled by its role prefix, which becomes the option text in §5.3 | `billing_` / `shipping_address_id`, `created_by_` / `assigned_to_employee_id` |

**Column roles**

| Rule | Detects | Role |
|---|---|---|
| C1 | Primary key | `identifier` |
| C2 | `deleted_at`, `archived_at`, `discarded_at`, `removed_at` (timestamp) or `is_deleted`, `is_archived` (bool) | soft-delete marker on the table |
| C3 | `updated_at`, `modified_at`, `*_synced_at`, `*_loaded_at` | `timestamp_audit` |
| C3b | `created_at`, `inserted_at`: audit, **unless** the table has no other event timestamp, in which case it is the event time | `customers.created_at` = signup time |
| C4 | Any other timestamp or date → `timestamp_event`. Default time column: COMMENT-marked if any, else NOT NULL before nullable, then `placed_at`/`occurred_at`/`started_at`/`opened_at`/`<verb>ed_at`, then `created_at` | `orders.placed_at` |
| C5 | Two event timestamps on the same row in lifecycle order (`placed → shipped → delivered`, `opened → first_response → resolved`), confirmed by sampled ordering → **duration measure candidates** `later − earlier` | `first_response_at − opened_at` |
| C6 | `boolean` | `boolean_flag` |
| C7 | Enum type or CHECK `IN` list | `dimension_categorical` with values |
| C8 | Text with `n_distinct` ≤ 50 (or ≤ 1% of rows) → categorical with `most_common_vals`; `description`/`body`/`notes`/`comment`/`message` or `avg_width` > 80 → `free_text`; otherwise `dimension_text` (trigram-searchable if it looks like a name, title, code, number, email or SKU) | `products.brand`, `web_sessions.device_type` |
| C9 | Numeric but not a measure: `*_id`, `code`, `zip`, `postal*`, `phone`, `*year`, `number`, `*_no`, `version`, `rank`, `position`, `sort_order`, `lat*`, `lng`/`lon*` | attribute (filter/group only) |
| C10 | Units from suffix or type: `_cents` (÷100, money), `money`, `_pct`/`_percent`, `_ms`/`_seconds`/`_minutes`, `_grams`/`_kg`/`_lbs` | `list_price_cents` → dollars |
| C11 | Additivity: `unit_*`, `price`, `rate`, `ratio`, `pct`, `percent`, `score`, `rating`, `avg`, `average`, `margin`, `age`, `temperature` → `measure_nonadditive`; `balance`, `on_hand`, `stock`, `inventory`, `level`, `headcount` → semi-additive; other numerics → `measure_additive` (low confidence, see §2.3) | `rating`, `unit_price_cents`, `unit_cost_cents` |
| C12 | Snapshot table: PK/UNIQUE = entity FK(s) + a date column (`snapshot_date`, `as_of`, `date`, `day`, `month`) → its measures are semi-additive across that date: default to the latest date, `avg` allowed, `sum` across dates masked | `inventory_snapshots` |
| C13 | Display column per table: first of `name`, `full_name`, `title`, `label`, `display_name`, `<table>_name`, `email`, `<table>_number`, `number`, `code`, `sku`. "By customer" groups by PK + display column | `employees` → `full_name`; `customers` has no name column, so `email` until config sets `[first_name, last_name]` |
| C14 | Tenant column (configurable names, default `tenant_id`, `org_id`, `organization_id`, `account_id`, `workspace_id`) on most tables → hidden from every choice; enforced by RLS or a config-injected predicate | — |
| C15 | PII-like columns (`email`, `phone`, `ssn`, `dob`, `line1`, …) → excluded from default projections, still filterable | `customers.email` |

Descriptions come from `COMMENT ON` when present, otherwise the humanized name ("orders: placed at"). Synonyms come from a small built-in lexicon (customer ↔ client/buyer/account, order ↔ purchase/sale, product ↔ item/SKU, …) plus singular/plural forms. Jev's semantic judgment covers the rest.

**Behavioral conventions**

- **Soft delete.** Current-state questions ("how many customers do we have") exclude soft-deleted rows of the subject table. Historical questions, meaning those with a time window or trend on the subject's *own* time column ("new customers per month in 2025"), include them. Joined tables are never filtered: orders placed by a since-closed account still count.
- **Money** in cents is displayed in dollars. If a currency column has more than one distinct value, the composer groups by it or asks.
- **Exclusion on nullable columns** keeps NULLs (`col <> $1 OR col IS NULL`).
- **Time**: UTC, ISO weeks, calendar quarters, and `as_of = now()` unless configured. `as_of` is injectable so tests are deterministic.

### 2.3 Optional setup pass with Jev

Rules leave some columns at low confidence: numeric columns with neutral names, text columns of unclear role, inferred FKs. One batched Jev request at setup time resolves them, staying within the "Jev selects, never generates" rule:

```json
{
  "additive_orders_handling_fee": {
    "type": "noul",
    "instructions": {
      "column": {"table": "orders", "name": "handling_fee", "type": "integer", "sample_values": [0, 495, 495, 995]},
      "question": "Is adding up `column` across many rows meaningful, the way amounts or quantities add up (as opposed to prices, rates, scores, or levels)?"
    }
  }
}
```

Answers go into the lockfile with their probabilities. Anything under the threshold is listed by `composer doctor` for a developer to confirm in `composer.yaml`. The pass is cheap, runs once per schema fingerprint, and can be skipped entirely.

### 2.4 `composer.yaml` (everything optional)

```yaml
database: { schemas: [shop], exclude_tables: [schema_migrations, ar_internal_metadata] }
time: { timezone: America/Los_Angeles, week_start: monday, fiscal_year_start_month: 1, last_period_means: calendar }
soft_delete: { mode: current_state_only }          # or: always | never
tenancy: { column: account_id }                     # or rely on RLS
overrides:
  orders.total_cents: { description: "Amount charged, including tax and shipping" }
  orders.handling_fee: { role: measure_additive, unit: cents }
  web_sessions.converted_order_id: { references: orders.id }
  customers: { display: [first_name, last_name] }
synonyms: { customers: [members], products: [gear] }
relationships:
  default_paths:
    orders->regions: customers                      # answer the region ambiguity once, for everyone
gating: { auto_execute_min_confidence: 0.85, margin_reask: 0.15 }
limits: { default_ranking: 10, max_rows: 5000, statement_timeout_ms: 15000 }
```

Config is for facts about the *schema* (units, missing FKs, display names, calendar). Facts about the *business* ("revenue excludes cancelled orders") go in the saved query library, where they are created by people accepting answers.

---

## 2B. Saved query library (replaces the metric catalog)

A metric catalog asks someone to define the business before the tool is useful, which breaks plug-and-play. But the problem it solves doesn't go away. "Revenue" means `SUM(line_total_cents)` excluding cancelled and refunded orders, and nothing in the schema says so. Conventions alone would either guess (wrong for someone) or ask. This design asks once, at use time (testbed case J01), and the accepted answer becomes the definition (J02–J06). The definition problem moves from setup to first use; it doesn't disappear, so the library needs light governance.

### Record types

| Kind | Holds | Created when |
|---|---|---|
| **Measure fragment** | name, trigger phrases, `{agg, column or duration pair, unit, row_filters}`, narrative | A user accepts a query whose measure came from a clarification or carries row filters |
| **Plan** | full `QueryPlan`, slots, pinned decisions (clarification answers), narrative, original request | A user accepts a query |
| **Filter fragment** (v1.5) | named row set, e.g. "active customers" = ordered in the last 90 days | A user accepts a query and names the filter |

Every record carries `scope` (user / team / org), `status` (accepted / canonical / deprecated), who accepted it and when, and a **fingerprint** of the columns and types it references.

### How saved records enter the pipeline

- **R0, plan match.** Before R1, retrieve the top-K saved plans by BM25/embedding over request and narrative, then ask one Choice:
  ```json
  {
    "saved_plan": {
      "type": "choice",
      "instructions": "Which saved question asks for the same thing as `request`, ignoring differences in dates, names, numbers, and added filters?",
      "criteria": {
        "plan_418": "Revenue (order line amounts, excluding cancelled and refunded orders) for each customer region, previous calendar month.",
        "plan_233": "Number of orders for each fulfillment warehouse region, previous calendar quarter.",
        "none": "None of these asks for the same thing."
      }
    }
  }
  ```
  If a plan is chosen confidently, the composer reuses it, keeps its pinned decisions (no re-asking which region), and R1 shrinks to slot-rebinding questions only: period, span roles, value links, and polarity of any new filters.
- **Slots are automatic.** A plan field whose provenance is a request span or a time period is a slot. Fields that came from schema choices are fixed.
- **Measure fragments are options.** In §5.4, in-scope fragments appear as `saved:<name>` options next to convention-derived candidates, labeled with their narrative. Code filters by scope: the user's own, their team's, and org-canonical.
- **Conflicts are shown.** Two canonical fragments that claim the same phrase both appear as options; the calibrated distribution decides or triggers a clarification. The composer never silently picks one.

### Drift

On schema change, saved plans are recompiled from the plan (not from stored SQL). A plan whose fingerprinted column is gone or changed type is marked stale and dropped from candidates.

### Interface for the meta project

The composer owns composition. The host app (the "meta project") owns acceptance UI, storage policy, and promotion to canonical.

```ts
compose(request, ctx?: { user, team, as_of, conversation }) -> Result
answer(clarificationId, optionKey) -> Result
accept(result, { scope, name? }) -> SavedRecord

type Result = {
  outcome: "execute" | "clarify" | "decline";
  sql?: string; params?: unknown[]; plan?: QueryPlan; narrative?: string;
  clarification?: { id: string; decision: string; options: { key: string; label: string; consequence: string }[] };
  provenance: Record<string, Decision>;
};

interface SavedQueryStore {        // default: Postgres tables in a `composer` schema
  search(text: string, scope: Scope, k: number): SavedRecord[];
  get(id: string): SavedRecord;
  put(record: SavedRecord): void;
  setStatus(id: string, status: "accepted" | "canonical" | "deprecated"): void;
}
```

---

## 3. Intermediate representation: `QueryPlan`

Jev decides fields of this object. SQL is a pure function of it.

```ts
type QueryPlan = {
  shape: "lookup" | "single_value" | "breakdown" | "ranking" | "trend" | "distribution";
  subject?: TableRef;                 // what is listed/counted (lookup, count shapes)
  measures: Measure[];                // SELECT aggregates
  projections: ColumnRef[];           // SELECT plain columns (lookup shape)
  dimensions: Dimension[];            // GROUP BY
  filters: Predicate[];               // WHERE (row level), ANDed
  existence: Existence[];             // EXISTS / NOT EXISTS
  having: HavingPredicate[];          // HAVING (group level)
  timeWindow?: TimeWindow;            // compiled into WHERE
  derived?: DerivedCalc;              // window functions over the result
  order: OrderTerm[];
  limit?: number;                     // from span or policy
  perGroupLimit?: { partitionBy: Dimension; n: number };
  distinct: boolean;
  joins: JoinTree;                    // computed by code, disambiguated by Jev
  provenance: Record<string, Decision>; // every field → question id, distribution, confidence
};

type Measure       = { saved?: SavedMeasureRef; agg?: Agg; column?: ColumnRef; duration?: { start: ColumnRef; end: ColumnRef }; filter?: Predicate[]; alias: string };
type Agg           = "count_rows" | "count_distinct" | "sum" | "avg" | "median" | "min" | "max";
type Dimension     = { column: ColumnRef; timeGrain?: "hour"|"day"|"week"|"month"|"quarter"|"year" };
type Predicate     = { column: ColumnRef; op: Op; values: Literal[]; source: SpanRef | ValueRef };
type Op            = "eq"|"neq"|"in"|"not_in"|"gt"|"gte"|"lt"|"lte"|"between"|"contains"|"starts_with"|"is_null"|"is_not_null"|"is_true"|"is_false";
type HavingPredicate = { measure: Measure; op: Op; value: Literal | AggregateRef };
type Existence     = { negated: boolean; related: TableRef; via: JoinPath; filters: Predicate[] };
type TimeWindow    = { column: ColumnRef; period: PeriodKey; n?: number; start?: DateParts; end?: DateParts };
type DerivedCalc   = "share_of_total" | "running_total" | "change_vs_previous" | "pct_change_vs_previous" | "rank" | "moving_average";
```

`provenance` is what makes clarification and debugging possible: every field in the final plan points back to the question that set it and the full distribution it came from.

---

## 4. Pre-Jev candidate generation (all code)

### 4.1 Span extraction
From the request, extract typed spans with character offsets:

| Span type | Extractor | Example |
|---|---|---|
| `number` | regex incl. words ("five", "a dozen"), `k`/`m` suffixes, currency, percent | `5`, `$1,200`, `10%` |
| `quoted` | regex for quotes | `"Acme Corp"` |
| `proper_noun` | capitalization + value-index hit | `West`, `Acme` |
| `relative_time` | phrase lexicon | `last quarter`, `past 30 days`, `YTD` |
| `explicit_date` | date-part candidates (see 5.8) | `March 2025`, `2025-03-01` |
| `content_phrase` | noun-chunker minus stopwords | `product categories`, `revenue` |

`content_phrase` spans feed retrieval and the coverage check in §8.

### 4.2 Value linking
Known values come from introspection, not a curated index: enum labels, CHECK lists, and `pg_stats.most_common_vals` for low-cardinality columns (C7, C8), held in memory and refreshed with the lockfile. Spans are fuzzy-matched against those in code. For high-cardinality name-like text columns (C8), query the column directly, using a trigram index when one exists:

```sql
SELECT DISTINCT company_name AS value, similarity(company_name, $1) AS sim
FROM shop.customers
WHERE company_name % $1          -- pg_trgm; falls back to ILIKE on a TABLESAMPLE when unindexed
ORDER BY sim DESC
LIMIT 20;
```

Output: `(column, canonical_value, span, sim)` candidates. Jev decides whether each is a real filter and its polarity; code owns the canonical spelling.

### 4.3 Schema retrieval
BM25 + embedding retrieval over table/column descriptions and synonyms → top-K tables (K≈8) and their columns. Always include tables reachable from value-linked columns. This bounds state size and keeps every Choice under 255 options.

### 4.4 Relative-period library
A closed set of period keys with deterministic Postgres bounds (§5.8). Jev picks the key; code computes the interval.

---

## 5. Building blocks

Conventions for every block:

- **Shared state** for a round:
  ```json
  {
    "request": "Top 5 product categories by revenue last quarter in the West region, excluding refunded orders",
    "schema": { "...": "pruned tables/columns with descriptions, units and known values" }
  }
  ```
- Question IDs are for code only; the full question goes in `instructions`.
- Candidate-specific data goes in a structured `instructions` object and is referenced by backtick path.
- `[C]` = code decision, `[J]` = Jev question.

Running example schema: `customers(customer_id, name, region_id, segment, created_at)`, `regions(region_id, name)`, `orders(order_id, customer_id, status, ordered_at, shipped_at, total_amount)`, `order_items(order_item_id, order_id, product_id, quantity, unit_price, line_amount)`, `products(product_id, name, category, list_price)`.

---

### 5.1 Query shape and feature flags (R1)

**Postgres effect:** decides which clauses exist at all.

| Shape | Clause skeleton |
|---|---|
| `lookup` | `SELECT cols FROM … WHERE … ORDER BY … LIMIT n` |
| `single_value` | `SELECT agg(…) FROM … WHERE …` |
| `breakdown` | `SELECT dims, agg(…) FROM … WHERE … GROUP BY dims ORDER BY agg DESC` |
| `ranking` | breakdown + `ORDER BY … LIMIT n` |
| `trend` | `SELECT date_trunc(g, t) AS period, agg(…) … GROUP BY 1 ORDER BY 1` |
| `distribution` | `width_bucket(…)` grouping (v2) |

**[J] Shape**
```json
{
  "shape": {
    "type": "choice",
    "instructions": "What kind of answer does `request` ask for?",
    "criteria": {
      "lookup": "A list of individual records and their details, with no totals or counts (e.g. 'show orders from Acme', 'list customers in Ohio').",
      "single_value": "One combined number for the whole set (e.g. 'how many orders last month', 'total revenue this year').",
      "breakdown": "Combined numbers shown separately for each category or group, with no restriction to the top or bottom few (e.g. 'revenue by region').",
      "ranking": "Items ordered by a quantity, usually restricted to the top or bottom few (e.g. 'top 5 customers by spend', 'which product sold the least').",
      "trend": "Combined numbers for each successive time period (e.g. 'monthly signups this year', 'orders per week').",
      "distribution": "How values are spread across ranges or buckets (e.g. 'histogram of order sizes').",
      "unsupported": "Not a request to read data: a request to create, change, or delete data, or a general question unrelated to the data."
    }
  }
}
```

**[J] Speculative feature flags** (all Nouls, all in R1, used or ignored by code):

| ID | `instructions` |
|---|---|
| `is_write` | Does `request` ask to create, change, or delete data? |
| `has_time_period` | Does `request` restrict results to a period of time? |
| `per_group_top_n` | Does `request` ask for the top or bottom few items *within each* group (e.g. 'top 3 products in each region') rather than overall? |
| `include_empty_groups` | Does `request` ask to include groups or records that have nothing to count (e.g. 'including customers with no orders', 'show zero months')? |
| `asks_absence` | Does `request` ask for records that do NOT have some related activity (e.g. 'customers who never ordered', 'products with no sales in March')? |
| `asks_presence_only` | Does `request` ask for records that have at least one related record, without needing any detail of those related records (e.g. 'customers who bought product X')? |
| `vs_overall_aggregate` | Does `request` compare individual values against an overall average, median, or total (e.g. 'orders above the average order value')? |
| `asks_share` | Does `request` ask what fraction or percentage of a total each item represents? |
| `asks_change` | Does `request` ask how a quantity changed from one period to the previous one? |
| `asks_running_total` | Does `request` ask for a cumulative or running total over time? |
| `asks_unique` | Does `request` ask for unique or different values only (e.g. 'which distinct cities')? |
| `single_best` | Does `request` ask for exactly one top or bottom item (e.g. 'which customer spent the most')? |

**[J] Specificity (Score)** — early clarification trigger:
```json
{
  "specificity": {
    "type": "score",
    "instructions": "How completely does `request` say what should be computed and about what?",
    "criteria": [
      "It is unclear what quantity or records are wanted.",
      "The general topic is clear but a key part is missing (what to measure, or what to measure it about).",
      "What to compute and what to compute it about are both clear."
    ]
  }
}
```

**[C]** `unsupported` or `is_write > 0.5` → decline. `specificity < 1.0` with low confidence → clarify before spending R2.

---

### 5.2 Subject entity / FROM grain (R1)

**Postgres:** the `FROM` table. For aggregate shapes, code derives it from the primary measure's `grain_table`; for `lookup` and count-style measures, it is the subject.

**[J] Subject**
```json
{
  "subject": {
    "type": "choice",
    "instructions": "Which kind of record does `request` list or count?",
    "criteria": {
      "orders": "Customer orders (also called purchases, sales, transactions).",
      "customers": "Customers (also called clients, buyers, accounts).",
      "products": "Products (also called items, SKUs).",
      "order_items": "Individual lines within an order.",
      "none": "The request does not list or count records; it asks for a total or average of an amount."
    }
  }
}
```

**[J] Table relevance** (one Noul per pruned table; table metadata in the instructions object):
```json
{
  "rel_regions": {
    "type": "noul",
    "instructions": {
      "table": {"name": "regions", "description": "Sales regions", "synonyms": ["territory", "area"], "example_values": ["West", "East", "Central", "South"]},
      "question": "Does `request` mention `table`, its records, or any of its attributes or values?"
    }
  }
}
```

**[C]** Relevance gates which columns enter R1 candidate sets for large schemas (two-stage: run relevance in a cheap R0 if the schema slice is too large for one state).

---

### 5.3 Joins (code-first, Jev only for ambiguity, R2)

**Postgres:**
```sql
FROM order_items oi
JOIN orders    o ON o.order_id    = oi.order_id
JOIN products  p ON p.product_id  = oi.product_id
JOIN customers c ON c.customer_id = o.customer_id
JOIN regions   r ON r.region_id   = c.region_id
```

**[C]**
1. Required tables = tables of selected measures ∪ dimensions ∪ filter columns (existence-only tables go to §5.9, not here).
2. Build the FK graph; find the minimum Steiner tree connecting required tables from the FROM table.
3. Join type: `INNER` by default; `LEFT` from the dimension side when `include_empty_groups` is high and the dimension's table is an entity table (e.g. all customers, including those with no orders) — then wrap counts in `COALESCE(…, 0)`.
4. If exactly one minimal tree exists, done. If several (role-playing FKs: `orders.billing_address_id` vs `orders.shipping_address_id`; `tickets.opened_by` vs `tickets.assigned_to`), ask.

**[J] Join path disambiguation** (options are paths rendered to English from `fk_description`):
```json
{
  "path_orders_addresses": {
    "type": "choice",
    "instructions": {
      "attribute": "address state",
      "question": "In `request`, the `attribute` belongs to which address of the order?"
    },
    "criteria": {
      "shipping": "The address the order was shipped to.",
      "billing": "The address the order was billed to.",
      "unclear": "The request does not say which address."
    }
  }
}
```

`unclear` with high probability → clarification, or the default path from `composer.yaml` (`relationships.default_paths`) if one is set, or a pinned decision from a matched saved plan.

---

### 5.4 Measures — SELECT aggregates (R1)

**Postgres:**
```sql
SUM(oi.line_amount)                                AS revenue
COUNT(*)                                           AS order_count
COUNT(DISTINCT o.customer_id)                      AS customer_count
AVG(o.total_amount)::numeric(14,2)                 AS avg_order_value
percentile_cont(0.5) WITHIN GROUP (ORDER BY o.total_amount) AS median_order_value
```

**[C] Candidates:** in-scope saved measure fragments first (§2B), then legal `(agg, column)` pairs from roles, then duration pairs (C5), then `count_rows` of each relevant table.

**[J] Primary quantity** (saved fragments + measure-role columns + durations + count targets + `none`):
```json
{
  "measure_quantity": {
    "type": "choice",
    "instructions": "Which quantity does `request` ask to compute?",
    "criteria": {
      "saved:revenue": "Revenue (saved definition): order line amounts, excluding cancelled and refunded orders.",
      "col:orders.total_amount": "Order total amount, including tax.",
      "col:order_items.quantity": "Number of units in an order line.",
      "col:products.list_price": "Catalog price of a product.",
      "dur:orders.placed_at>delivered_at": "Time from placing an order to its delivery.",
      "count:orders": "The number of orders.",
      "count:customers": "The number of customers.",
      "count:products": "The number of products.",
      "none": "No quantity is computed; the request only lists records."
    }
  }
}
```

**[J] Aggregation** (asked in the same round, combined by masked joint decoding):
```json
{
  "measure_agg": {
    "type": "choice",
    "instructions": "How does `request` ask for the quantity to be combined across records?",
    "criteria": {
      "sum": "A total or combined amount ('total revenue', 'how much was spent').",
      "avg": "A typical or average value per record ('average order value', 'mean').",
      "median": "The middle value ('median').",
      "max": "The single largest or latest value ('biggest order', 'highest price').",
      "min": "The single smallest or earliest value ('smallest order', 'lowest price').",
      "count_rows": "How many records ('how many orders', 'number of').",
      "count_distinct": "How many different things ('how many customers placed orders', 'unique')."
    }
  }
}
```

**[C]** `P(q, agg) ∝ P(q)·P(agg)·legal(q, agg)`. Saved fragments carry a fixed aggregate and row filters, so `saved:*` candidates ignore `measure_agg`. Duration candidates allow only `avg`, `median`, `min`, `max`. For `count:<table>` in a query that joins through 1:N edges, compile to `COUNT(DISTINCT <pk>)` (see §7 fan-out).

**[J] Secondary measures** — one Noul per remaining candidate, so multi-measure requests ("revenue and order count by region") are captured without a counting question:
```json
{
  "also_count_orders": {
    "type": "noul",
    "instructions": {
      "quantity": "the number of orders",
      "question": "Besides its main quantity, does `request` also ask for `quantity`?"
    }
  }
}
```

---

### 5.5 Projections — SELECT columns for `lookup` (R1)

**Postgres:** `SELECT o.order_id, o.ordered_at, c.name, o.total_amount`

**[C]** Start from the subject's convention defaults: identifier, display column (C13), default time column (C4), first additive measure; minus PII columns (C15).

**[J]** One Noul per non-default column of relevant tables:
```json
{
  "show_customers_segment": {
    "type": "noul",
    "instructions": {
      "column": {"table": "customers", "name": "segment", "description": "Customer segment (SMB, Mid-market, Enterprise)"},
      "question": "Does `request` ask to see `column` in the results?"
    },
    "criteria": {
      "true": "The request names this attribute as something to display or include.",
      "false": "The attribute is not mentioned, or is only used to narrow down which records are shown."
    }
  }
}
```

The `false` criterion explicitly separates "show me X" from "where X is …" — the most common projection error.

---

### 5.6 Dimensions — GROUP BY and time grain (R1)

**Postgres:**
```sql
SELECT p.category, date_trunc('month', o.ordered_at AT TIME ZONE $tz) AS month, SUM(...)
...
GROUP BY p.category, month
```

**[J]** One Noul per categorical/text dimension candidate:
```json
{
  "group_products_category": {
    "type": "noul",
    "instructions": {
      "attribute": {"table": "products", "name": "category", "description": "Product category"},
      "question": "Does `request` ask for results shown separately for each value of `attribute`?"
    },
    "criteria": {
      "true": "Phrases like 'by category', 'per category', 'for each category', 'broken down by', 'top categories'.",
      "false": "The attribute only narrows results to particular values (e.g. 'in the Toys category'), or is not mentioned."
    }
  }
}
```

**[J] Time grain:**
```json
{
  "time_grain": {
    "type": "choice",
    "instructions": "Does `request` ask for results for each time period, and if so how long is each period?",
    "criteria": {
      "none": "Results are not split by time period.",
      "hour": "Each hour ('hourly').",
      "day": "Each day ('daily', 'per day').",
      "week": "Each week ('weekly').",
      "month": "Each month ('monthly', 'by month').",
      "quarter": "Each quarter ('quarterly').",
      "year": "Each year ('yearly', 'annual', 'by year')."
    }
  }
}
```

**[C]** Weeks follow Postgres ISO weeks (`date_trunc('week', …)` starts Monday); if the org uses Sunday weeks or a fiscal calendar, compile from a calendar table named in `composer.yaml` instead. For `trend`, optionally gap-fill:
```sql
SELECT g.period, COALESCE(t.value, 0) AS value
FROM generate_series($start, $end - interval '1 month', interval '1 month') AS g(period)
LEFT JOIN t ON t.period = g.period
```

---

### 5.7 Filters — WHERE (R1, operators R1 speculative)

**Postgres:**
```sql
WHERE r.name = $1
  AND o.status <> $2
  AND o.total_amount > $3
  AND c.name ILIKE '%' || $4 || '%'
  AND c.email IS NULL
```
All literals are bind parameters. `<>` on a nullable column: compile as `(col <> $2 OR col IS NULL)` when the column is nullable and the intent is "exclude X" (otherwise NULL rows silently disappear).

#### 5.7a Value-linked candidates: acceptance + polarity in one Choice
```json
{
  "filter_orders_status_refunded": {
    "type": "choice",
    "instructions": {
      "candidate": {"attribute": "order status", "value": "refunded", "matched_text": "refunded"},
      "question": "How does `request` use `candidate.attribute` being `candidate.value`?"
    },
    "criteria": {
      "keep_only": "Results are limited to records where the attribute has this value (e.g. 'refunded orders', 'only refunded').",
      "exclude": "Records with this value are removed (e.g. 'excluding refunded', 'not refunded', 'other than refunded').",
      "not_a_condition": "The words do not restrict results by this attribute (they mean something else, or the match is coincidental)."
    }
  }
}
```

**[C]** Per column: all `keep_only` values → `= $` or `IN (…)`; all `exclude` values → `<>` / `NOT IN`. Mixed keep/exclude on one column → keep wins, log for review. Across columns: AND.

#### 5.7b Span role classifier (the hub for every literal)
One Choice per extracted `number` span. Its options cover every place a literal can go:
```json
{
  "role_span_0": {
    "type": "choice",
    "instructions": {
      "span": "5",
      "question": "In `request`, what does the number `span` refer to?"
    },
    "criteria": {
      "result_count": "How many results to show ('top 5', 'first 10').",
      "time_amount": "A length of time ('last 5 days', '5 months').",
      "threshold:orders.total_amount": "A limit on an order's total amount.",
      "threshold:order_items.quantity": "A limit on the number of units in an order line.",
      "threshold:count:orders": "A limit on how many orders something has ('more than 5 orders').",
      "threshold:saved:revenue": "A limit on revenue.",
      "part_of_name": "Part of a name, code, or identifier ('Store 5', 'SKU 5512').",
      "year_or_date": "Part of a date ('2025', 'March 5').",
      "none": "None of the above."
    }
  }
}
```

**[C]** Hungarian assignment over the span × role matrix. Then per role:
- `result_count` → `limit`
- `time_amount` → `n` for the period (§5.8)
- `threshold:<row-level column>` → WHERE predicate
- `threshold:count:*` / `threshold:saved:*` → candidate HAVING (§5.10)
- `part_of_name` → re-route to text-match candidates
- `year_or_date` → date-part extraction (§5.8)

Code normalizes the literal (`$1,200` → `1200`, `10%` → `0.10` if the column is stored as a fraction per its inferred unit (C10)).

#### 5.7c Comparison operator per numeric threshold span
```json
{
  "op_span_2": {
    "type": "choice",
    "instructions": {
      "span": "100",
      "question": "In `request`, how are values compared to `span`?"
    },
    "criteria": {
      "gt": "Strictly greater ('more than', 'over', 'above', 'exceeding').",
      "gte": "Greater or equal ('at least', 'or more', 'minimum of').",
      "lt": "Strictly less ('less than', 'under', 'below', 'fewer than').",
      "lte": "Less or equal ('at most', 'or less', 'up to', 'no more than').",
      "eq": "Exactly equal ('exactly', 'equal to', 'of').",
      "between_low": "The lower end of a range ('between 100 and 500').",
      "between_high": "The upper end of a range ('between 100 and 500')."
    }
  }
}
```
Two spans tagged `between_low`/`between_high` on the same column → `BETWEEN $a AND $b` (inclusive per SQL; document this in the narrative).

#### 5.7d Text match for unlinked strings (quoted strings, proper nouns with no exact value hit)
```json
{
  "text_col_span_3": {
    "type": "choice",
    "instructions": {
      "span": "Acme",
      "question": "In `request`, `span` is a value of which attribute?"
    },
    "criteria": {
      "customers.name": "Customer name.",
      "products.name": "Product name.",
      "regions.name": "Region name.",
      "none": "It is not a value of any listed attribute."
    }
  },
  "text_mode_span_3": {
    "type": "choice",
    "instructions": {
      "span": "Acme",
      "question": "Does `request` ask for an exact match of `span`, or for values that contain or start with it?"
    },
    "criteria": {
      "exact": "The value is exactly this (a full name or code).",
      "contains": "The value includes this text somewhere ('containing', 'with Acme in the name', or a partial name).",
      "starts_with": "The value begins with this text ('starting with', 'beginning with')."
    }
  }
}
```
Compile: `exact` → `= $` (or `lower(col) = lower($)` if the column is `citext` or config marks it case-insensitive), `contains` → `ILIKE '%' || $ || '%'`, `starts_with` → `ILIKE $ || '%'`. Escape `%` and `_` in the bound value.

#### 5.7e Null checks
One Noul per nullable column of relevant tables, asked only when the request contains missing/empty vocabulary (code-side trigger):
```json
{
  "null_customers_email": {
    "type": "noul",
    "instructions": {
      "attribute": "customer email",
      "question": "Does `request` ask for records where `attribute` is missing or empty?"
    }
  }
}
```

#### 5.7f OR across different columns (v1: detect and clarify, don't compose)
```json
{
  "or_pair_0_1": {
    "type": "noul",
    "instructions": {
      "a": "region is West",
      "b": "segment is Enterprise",
      "question": "Does `request` accept records that meet either `a` or `b`, with either one being enough?"
    }
  }
}
```
High → v1 clarifies or compiles `(A OR B)` only if the pair is the only cross-column condition.

---

### 5.8 Time windows (R1, date column R2 if needed)

**Postgres** — always half-open intervals on the event column, in the org's timezone:
```sql
-- last_quarter (previous complete calendar quarter)
o.ordered_at >= (date_trunc('quarter', now() AT TIME ZONE $tz) - interval '3 months') AT TIME ZONE $tz
AND o.ordered_at <  date_trunc('quarter', now() AT TIME ZONE $tz) AT TIME ZONE $tz
```

**[J] Period:**
```json
{
  "period": {
    "type": "choice",
    "instructions": "Which time period does `request` restrict results to?",
    "criteria": {
      "none": "No time restriction.",
      "today": "Today.",
      "yesterday": "Yesterday.",
      "this_week": "The current week so far.",
      "last_week": "The previous complete week.",
      "this_month": "The current month so far ('this month', 'month to date').",
      "last_month": "The previous complete calendar month.",
      "this_quarter": "The current quarter so far.",
      "last_quarter": "The previous complete calendar quarter ('last quarter', 'Q3' when Q3 just ended).",
      "this_year": "The current year so far ('this year', 'YTD', 'year to date').",
      "last_year": "The previous complete calendar year.",
      "trailing_n_days": "A rolling number of days ending now ('last 30 days', 'past week' when meaning 7 days).",
      "trailing_n_weeks": "A rolling number of weeks ending now ('last 6 weeks').",
      "trailing_n_months": "A rolling number of months ending now ('last 3 months', 'past 12 months').",
      "specific_month": "A named month ('in March', 'March 2025').",
      "specific_quarter": "A named quarter ('Q2 2025').",
      "specific_year": "A named year ('in 2024').",
      "since_date": "From a specific date until now ('since January 15').",
      "before_date": "Before a specific date.",
      "between_dates": "Between two specific dates."
    }
  }
}
```

| Key | Bounds computed in code `[start, end)` |
|---|---|
| `last_month` | `date_trunc('month', now) - 1 month`, `date_trunc('month', now)` |
| `trailing_n_days` | `now - n days`, `now` (n from span role `time_amount`) |
| `this_year` | `date_trunc('year', now)`, `now` |
| `specific_month` | from date parts below |
| … | one row per key, fully deterministic |

**[J] Date parts** for explicit dates (per the TypeSafe date-extraction approach: every part is a closed set with a `not_stated` option):
```json
{
  "start_month": {
    "type": "choice",
    "instructions": "Which month is the start of the date range named in `request`?",
    "criteria": {
      "not_stated": "No month is named for the start.",
      "1": "January", "2": "February", "3": "March", "4": "April", "5": "May", "6": "June",
      "7": "July", "8": "August", "9": "September", "10": "October", "11": "November", "12": "December"
    }
  }
}
```
Years: Choice over the years appearing as spans plus `not_stated` (code infers the most recent past occurrence). Days: Choice over day-number spans. Code assembles and validates the date.

**[J] Date column** (only when the subject has more than one `timestamp_event`; R2):
```json
{
  "time_column": {
    "type": "choice",
    "instructions": "Which moment does the time period in `request` refer to?",
    "criteria": {
      "orders.ordered_at": "When the order was placed (default for 'orders last month').",
      "orders.shipped_at": "When the order shipped ('shipped last month')."
    }
  }
}
```
Fall back to the convention default time column (C4) when the distribution is flat.

**Known ambiguity:** "last quarter" / "last month" (previous calendar period vs trailing window). The criteria encode the house default; if `last_quarter` vs `trailing_n_months` margin is small, clarify with the computed date ranges.

---

### 5.9 Existence — EXISTS / NOT EXISTS (R1 flags, R2 scoping)

**Postgres:**
```sql
SELECT c.customer_id, c.name
FROM customers c
WHERE NOT EXISTS (
  SELECT 1 FROM orders o
  WHERE o.customer_id = c.customer_id
    AND o.ordered_at >= $1 AND o.ordered_at < $2
)
```

Use EXISTS whenever a related table is needed only to test for presence. It never multiplies rows, unlike a JOIN.

**[J]** One Noul per (subject, related table) pair reachable by FK, asked when `asks_absence` or `asks_presence_only` is likely:
```json
{
  "absent_customers_orders": {
    "type": "noul",
    "instructions": {
      "subject": "customers",
      "related": "orders",
      "question": "Does `request` ask for `subject` that have no matching `related`?"
    }
  }
}
```

**[C]** Scoping: a filter goes inside the subquery if its column belongs to the related table, outside otherwise. "Customers in the West who didn't order in March": `region` → outer, `ordered_at` → inner. This is deterministic from column ownership; no question needed.

---

### 5.10 HAVING — conditions on groups (R1 role, R2 target)

**Postgres:**
```sql
SELECT c.customer_id, c.name, COUNT(*) AS order_count
FROM customers c JOIN orders o ON o.customer_id = c.customer_id
GROUP BY c.customer_id, c.name
HAVING COUNT(*) > $1
```

Triggered when the span role classifier assigns `threshold:count:*` or `threshold:saved:*`, or when a threshold is on an additive measure and grouping exists.

**[J] Row vs group:**
```json
{
  "level_span_2": {
    "type": "choice",
    "instructions": {
      "span": "5",
      "question": "In `request`, is the condition on `span` about each individual record, or about a total or count for each group?"
    },
    "criteria": {
      "row": "Each record on its own ('orders over $100': each order's amount).",
      "group": "A total or count per group ('customers with more than 5 orders', 'categories with over $1M in sales')."
    }
  }
}
```

**[C]** `group` → the HAVING measure may differ from the displayed measure ("show customer names with more than 5 orders" displays names, filters on `COUNT(*)`); if the HAVING measure isn't already selected, add it as a hidden measure or reuse the expression. If there are no dimensions yet, the group is the subject entity (`GROUP BY subject.pk`, plus display columns).

---

### 5.11 ORDER BY (R2)

**Postgres:** `ORDER BY revenue DESC NULLS LAST, p.category ASC` (always add a deterministic tiebreaker on a dimension or PK).

**[C] Defaults by shape:** `trend` → period ASC; `breakdown`/`ranking` → primary measure DESC; `lookup` → default time column DESC.

**[J] Sort key** (options are the plan's selected measures and dimensions, so this is R2):
```json
{
  "sort_key": {
    "type": "choice",
    "instructions": "By what does `request` ask the results to be ordered?",
    "criteria": {
      "measure:revenue": "By revenue.",
      "dim:products.category": "By category name.",
      "unspecified": "The request does not say how to order results."
    }
  },
  "sort_dir": {
    "type": "choice",
    "instructions": "In which direction does `request` ask the results to be ordered?",
    "criteria": {
      "high_first": "Largest or most first ('top', 'most', 'highest', 'best', 'biggest').",
      "low_first": "Smallest or least first ('bottom', 'least', 'lowest', 'worst', 'fewest').",
      "newest_first": "Most recent first ('latest', 'most recent').",
      "oldest_first": "Earliest first ('earliest', 'oldest', 'first').",
      "alphabetical": "Alphabetical order.",
      "unspecified": "No direction is stated."
    }
  }
}
```
`sort_dir` is speculative in R1 (it doesn't depend on the plan); only `sort_key` waits for R2.

---

### 5.12 LIMIT and per-group top-N

**Postgres:**
```sql
LIMIT $n

-- per-group top-N
SELECT * FROM (
  SELECT r.name AS region, p.name AS product, SUM(oi.line_amount) AS revenue,
         row_number() OVER (PARTITION BY r.name ORDER BY SUM(oi.line_amount) DESC) AS rn
  FROM ... GROUP BY r.name, p.name
) ranked
WHERE rn <= $n
ORDER BY region, rn
```

**[C]**
- `limit` = span with role `result_count`; else 1 if `single_best` is high; else policy default (e.g. 10 for `ranking`, 1000 safety cap for `lookup`, none for `trend`/`breakdown` under a safety cap).
- `per_group_top_n` high → partition by the dimension that "each"/"per" attaches to. If there are 2+ dimensions, ask which one is the partition:

```json
{
  "partition_dim": {
    "type": "choice",
    "instructions": "In `request`, the top results are picked separately within each what?",
    "criteria": {
      "dim:regions.name": "Within each region.",
      "dim:products.category": "Within each category."
    }
  }
}
```
Ties: `row_number()` by default; `rank()` if the request says "including ties" (Noul, optional).

---

### 5.13 DISTINCT

**Postgres:** `SELECT DISTINCT c.city FROM customers c ...` or `DISTINCT ON (c.customer_id)` for "latest order per customer".

**[C]** `lookup` with only dimension projections + `asks_unique` → `SELECT DISTINCT`. "Latest/first X per Y" (`single_best` + per-group phrasing) → `DISTINCT ON (y) … ORDER BY y, t DESC` (Postgres-specific, cleaner than a window for N=1). Never use DISTINCT to paper over join fan-out; fix the join (§7).

---

### 5.14 Derived calculations — window functions (R1)

**Postgres:**
```sql
-- share of total
SUM(oi.line_amount) / NULLIF(SUM(SUM(oi.line_amount)) OVER (), 0)                 AS share
-- running total (trend)
SUM(SUM(o.total_amount)) OVER (ORDER BY month)                                   AS running_total
-- change vs previous period
SUM(o.total_amount) - LAG(SUM(o.total_amount)) OVER (ORDER BY month)              AS change
(SUM(o.total_amount) / NULLIF(LAG(SUM(o.total_amount)) OVER (ORDER BY month), 0)) - 1 AS pct_change
-- moving average (3 periods)
AVG(SUM(o.total_amount)) OVER (ORDER BY month ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS ma3
```

**[J]**
```json
{
  "derived": {
    "type": "choice",
    "instructions": "Besides the quantity itself, what extra calculation does `request` ask for?",
    "criteria": {
      "none": "No extra calculation.",
      "share_of_total": "Each item's fraction or percentage of the overall total ('share', '% of total', 'proportion').",
      "running_total": "A cumulative total that adds up over time ('running total', 'cumulative').",
      "change_vs_previous": "The difference from the previous period ('change from last month', 'increase').",
      "pct_change_vs_previous": "The percentage difference from the previous period ('growth rate', '% change', 'month over month').",
      "rank": "Each item's position in an ordering ('rank', 'ranking position').",
      "moving_average": "An average over a sliding window of recent periods ('rolling average', '7-day average')."
    }
  }
}
```
Window size for `moving_average` comes from a `time_amount` span. `change_vs_previous` requires `trend` shape (or a two-period comparison, §5.15); otherwise code downgrades and clarifies.

---

### 5.15 Conditional aggregation — FILTER (pivot-style columns)

**Postgres** (prefer `FILTER` over `CASE` inside aggregates):
```sql
SELECT date_trunc('month', o.ordered_at) AS month,
       COUNT(*) FILTER (WHERE o.status = 'paid')     AS paid,
       COUNT(*) FILTER (WHERE o.status = 'refunded') AS refunded
FROM orders o
GROUP BY 1 ORDER BY 1
```
Also used for period comparisons: `SUM(x) FILTER (WHERE t >= $this_start) AS this_year, SUM(x) FILTER (WHERE t >= $last_start AND t < $last_end) AS last_year`.

**[J]**
```json
{
  "pivot_status": {
    "type": "noul",
    "instructions": {
      "attribute": "order status",
      "question": "Does `request` ask to see the quantity for different values of `attribute` side by side as separate columns (e.g. 'paid vs refunded orders by month')?"
    }
  },
  "compare_periods": {
    "type": "noul",
    "instructions": "Does `request` ask to compare the same quantity across two separate time periods (e.g. 'this year vs last year', 'Q3 compared to Q2')?"
  }
}
```

**[C]** Pivot is only offered for `dimension_categorical` columns with ≤ ~12 known values; otherwise fall back to a row-wise GROUP BY.

---

### 5.16 Comparison against an overall aggregate — scalar subquery / CTE

**Postgres:**
```sql
WITH overall AS (SELECT AVG(total_amount) AS avg_amt FROM orders WHERE ordered_at >= $1 AND ordered_at < $2)
SELECT o.order_id, o.total_amount
FROM orders o, overall
WHERE o.total_amount > overall.avg_amt
  AND o.ordered_at >= $1 AND o.ordered_at < $2
```

Add `aggregate_ref:avg`, `aggregate_ref:median` as options to the threshold side of the span role logic, and when `vs_overall_aggregate` is high, ask:
```json
{
  "overall_ref": {
    "type": "choice",
    "instructions": "In `request`, values are compared against which overall figure?",
    "criteria": {
      "avg": "The overall average ('above average', 'more than the mean').",
      "median": "The overall median ('above the median').",
      "total": "The overall total.",
      "max": "The overall maximum."
    }
  }
}
```
**[C]** The CTE inherits the outer query's WHERE filters by default ("orders above average *last month*" compares to last month's average). Make this explicit in the narrative so the user can spot the other reading.

---

### 5.17 Deferred to v2+

| Construct | Why deferred |
|---|---|
| `UNION` / `INTERSECT` / `EXCEPT` | Rare in report requests; express as two plans or EXISTS combos. |
| Recursive CTEs (hierarchies) | Self-references are already detected (R4); needs recursive compile and parent-category value linking (testbed I02). |
| Ad hoc arithmetic expressions (`price - cost`) | Jev can't generate formulas. v2: saved fragments may carry a formula written by a person or a generative model and accepted by a user. |
| JSONB paths | Infer keys from a sample (or declare them in `composer.yaml`) as virtual columns, then they're ordinary columns (`attributes->>'color'`). |
| Arrays (`= ANY`, `@>`) | Add as roles with their own operator set. |
| Self-joins (manager of employee) | Model as role paths (R5). |
| `width_bucket` distributions | Needs bucket-scheme Choice + code-computed bounds. |

---

## 6. Round plan

| Round | True dependency | Contents | Typical question count |
|---|---|---|---|
| **R0** | Retrieval only | Saved-plan match Choice (§2B); table relevance Nouls for large schemas | 1–60 |
| **R1** | Spans, value-link candidates, pruned schema model (or only slot questions after a plan match) | Shape, specificity, ~12 feature flags, subject, measure quantity + agg, secondary measure Nouls, projection Nouls, dimension Nouls, time grain, period, date parts, span roles, operators, text-column + text-mode, filter polarity, null checks, sort direction, derived calc, pivot/compare flags | 40–150 |
| **[code]** | R1 answers | Masked joint decoding, Hungarian span assignment, required tables, Steiner join trees, candidate sort keys | — |
| **R2** | Selected plan elements | Join-path disambiguation, date column, row vs group level, HAVING target, sort key, partition dimension, overall-aggregate ref, rotated re-asks of low-margin Choices | 5–30 |
| **[code]** | R2 answers | Assemble, validate, fan-out rewrite, compile, render narrative | — |
| **R3** | Compiled plan | Span coverage Nouls, narrative agreement Score + Nouls | 5–25 |

Per the TypeSafe docs, extra questions in one request are cheap and run in parallel, so R1 deliberately over-asks: questions whose answers turn out irrelevant are simply ignored.

---

## 7. Assembly and Postgres compile rules

**Emission order:** `WITH` → `SELECT [DISTINCT [ON]]` → `FROM` / `JOIN` → `WHERE` (filters, time window, existence) → `GROUP BY` → `HAVING` → window wrapping (derived, per-group top-N) → `ORDER BY` → `LIMIT`.

**Build the AST, not strings.** Emit through `sqlglot` (dialect `postgres`) or `pglast`, then round-trip parse as a validity check. Identifiers come only from the schema model and are quoted by the emitter.

**Literals are always bind parameters** (`$1…$n`), never interpolated, including `ILIKE` patterns (escape `%`, `_`, `\` in the value).

**Fan-out (chasm/fan trap) — the most important correctness rule.** If a measure's table sits on the "one" side of any 1:N edge in the join tree, joining multiplies its rows and inflates SUM/COUNT. Example: `SUM(orders.total_amount)` grouped by `products.category` via `order_items` double-counts multi-line orders. Code must:
1. Annotate each relationship with cardinality from constraints (R1–R3).
2. For each measure, check whether any path from its table to a dimension/filter table crosses 1:N away from it.
3. If so, either pre-aggregate the measure at its own grain in a CTE and join the result, or switch to a measure at the finer grain (`order_items.line_amount`) if a saved fragment or config declares it equivalent, or for counts use `COUNT(DISTINCT pk)`.
4. If none of these is valid (the question itself is ill-posed, e.g. order totals "by product"), clarify rather than emit an inflated number.

Generated-SQL systems get this wrong constantly. Here it's a deterministic graph check.

**Type and NULL hygiene:**
- `AVG(int)` → cast result `::numeric(…, 2)` for display.
- Division → `NULLIF(denominator, 0)`.
- LEFT JOIN counts → `COALESCE(COUNT(child.pk), 0)`; never `COUNT(*)` on the preserved side.
- `<>` / `NOT IN` on nullable columns → add `OR col IS NULL` when the intent is exclusion; never `NOT IN (subquery)` (NULL trap), use `NOT EXISTS`.
- `ORDER BY measure DESC NULLS LAST`.

**Time:** compute bounds in code from the org timezone; compare `timestamptz` columns to `timestamptz` parameters; group with `date_trunc(grain, col AT TIME ZONE $tz)`.

**Running example, compiled:**
```sql
SELECT p.category,
       SUM(oi.line_amount) AS revenue
FROM order_items oi
JOIN orders    o ON o.order_id    = oi.order_id
JOIN products  p ON p.product_id  = oi.product_id
JOIN customers c ON c.customer_id = o.customer_id
JOIN regions   r ON r.region_id   = c.region_id
WHERE o.status NOT IN ($1, $2)             -- saved 'revenue' fragment's row filter: cancelled, refunded
  AND (o.status <> $3 OR o.status IS NULL) -- 'excluding refunded' (implied by the fragment; kept, harmless)
  AND r.name = $4                          -- 'West'
  AND o.ordered_at >= $5 AND o.ordered_at < $6   -- 2026-07-01, 2026-10-01 in org tz
GROUP BY p.category
ORDER BY revenue DESC NULLS LAST, p.category
LIMIT $7;                                   -- 5
```
A simplification pass drops filters implied by saved definitions (`<> 'refunded'` is implied by `NOT IN ('cancelled','refunded')`), but only after the narrative records that the user's exclusion is honored.

**Execution guardrails:** read-only role; `SET LOCAL statement_timeout`; `EXPLAIN` first and reject plans above a cost ceiling; tenancy enforced by RLS on the executing role, not by the composer, so a composer bug can't leak across tenants.

---

## 8. Verification and gating

### 8.1 Plan narrative
Deterministically render the plan to English (template per IR node). Shown to the user with every result, and used as R3 state:

> Total revenue (order line amounts, excluding cancelled and refunded orders, per your saved definition) for each product category, for orders placed Jul 1 – Sep 30, 2026, where the customer's region is West and order status is not refunded, highest first, top 5.

### 8.2 R3 questions
```json
{
  "state": {
    "request": "Top 5 product categories by revenue last quarter in the West region, excluding refunded orders",
    "plan_summary": "Total revenue (order line amounts, excluding cancelled and refunded orders, per your saved definition) for each product category, for orders placed Jul 1 – Sep 30, 2026, where the customer's region is West and order status is not refunded, highest first, top 5."
  },
  "questions": {
    "agreement": {
      "type": "score",
      "instructions": "How well does `plan_summary` answer `request`?",
      "criteria": [
        "It answers a different question.",
        "It answers part of the request, or adds conditions the request did not ask for.",
        "It answers the request with a minor difference in interpretation.",
        "It answers exactly what the request asks."
      ]
    },
    "extra_condition": {
      "type": "noul",
      "instructions": "Does `plan_summary` contain a restriction or calculation that `request` did not ask for?"
    },
    "covered_span_0": {
      "type": "noul",
      "instructions": {
        "phrase": "excluding refunded orders",
        "question": "Is `phrase` from `request` reflected in `plan_summary`?"
      }
    }
  }
}
```
One `covered_span_*` per `content_phrase` span. An uncovered phrase is the signature of a dropped constraint, the most common silent failure in NL→SQL. Note: `extra_condition` will fire on conditions implied by a saved definition or a convention (soft delete, the revenue fragment's status filter). The narrative marks those distinctly ("per your saved definition", "excluding closed accounts"), and R3 excludes them from this check.

### 8.3 Gating policy
- Each decision has a confidence (Choice/Score `confidence`; Noul → `|p − 0.5| · 2`).
- **Option-order check:** any Choice whose top-2 margin < δ is re-asked in R2 with options reversed; average the two distributions.
- **Plan confidence** = min over *load-bearing* decisions (those that change the SQL), not the product over all speculative questions.
- **Thresholds** are tuned on the eval set to hit a target precision for auto-execution (e.g. ≥ 97% correct among auto-executed), trading off coverage.
- Outcomes: execute; execute-with-banner (show narrative + "did you mean" alternative); clarify; decline.

### 8.4 Clarification from distributions
The runner-up options *are* the clarifying question. For `period` with `{last_quarter: 0.52, trailing_n_months: 0.41}`:

> By "last quarter," do you mean **Jul 1 – Sep 30, 2026** or **the last 3 months (Jul 5 – Oct 5)**?

Code renders each option with its computed consequence (actual dates, actual column names, actual join meaning). The user's pick overrides that one decision; the rest of the plan is reused without re-asking Jev.

---

## 9. Running it behind a model-agnostic interface

The composer depends only on:
```ts
ask(state, questions: Record<string, Choice | Score | Noul>) -> Record<string, Answer>
```
so Jev and a self-hosted equivalent are interchangeable. Relevant because the report builder must stay inside a self-hosted / FedRAMP boundary, and R1 state contains schema metadata plus matched data values.

Self-hosted implementation sketch for an open-weights model:
- **Choice:** present options with single-token labels (A, B, C…), read next-token logprobs over the label tokens, renormalize. For >26 options, two-token labels or hierarchical rounds.
- **Noul:** `P(Yes) / (P(Yes) + P(No))` from next-token logprobs.
- **Score:** distribution over level-index tokens; `score` = expectation.
- **Debias:** average over 2 option permutations for low-margin decisions (same fix as §8.3).
- **Calibrate:** temperature scaling per question family on labeled data; the gating thresholds assume calibration.
- **Throughput:** put the shared state first and each question after it so the KV cache prefix is reused across the whole round (vLLM / SGLang prefix caching); a round becomes one prefill plus N short suffixes.

---

## 10. Evaluation

- **Testbed.** `nlsql-testbed/` ships a Postgres schema built around convention traps (fan and chasm traps, role-playing FKs, soft deletes, cents, snapshot tables, missing FKs, a junction table, value collisions), a deterministic seed anchored to `as_of = 2026-10-05`, and 61 cases tagged by building block with verified gold SQL, known-wrong answers, and a scoring harness. Use it for development; use public schemas (below) to check that conventions generalize to schemas the tool wasn't designed around.
- **Plan-level gold set** from your own schemas: (request → QueryPlan). Score per decision type (shape, measure, dims, filters, time, order/limit), which tells you *which* question to fix. SQL string match is the wrong metric.
- **Execution accuracy**: compare result sets of compiled gold vs predicted plans on a fixed snapshot.
- **Calibration**: reliability curves per question family; headline metric = precision of auto-executed queries at a given coverage.
- **Unseen schemas**: Pagila, Chinook and Northwind on Postgres with no `composer.yaml`, to measure zero-config accuracy. Spider and BIRD dev sets ported to Postgres for breadth (both originate in SQLite). Expect a structured composer to trail free-generation on exotic queries and beat it on precision-at-coverage.
- **Option-order audit**: run the eval with reversed option order; decisions that flip go on the rotation list.
- **Adversarial set**: requests with negation ("not", "excluding", "never"), inclusive/exclusive boundaries, role-playing joins, and fan-out traps.

---

## 11. v1 scope

**In:** read-only single `SELECT`; shapes `lookup`, `single_value`, `breakdown`, `ranking`, `trend`; filters `=`, `<>`, `IN`, `NOT IN`, numeric comparisons, `BETWEEN`, `ILIKE`, `IS [NOT] NULL`, booleans; relative and explicit time windows; `EXISTS` / `NOT EXISTS`; one HAVING predicate; `share_of_total`, `running_total`, `change_vs_previous`, `pct_change_vs_previous`; per-group top-N; `DISTINCT ON` for latest-per-group; duration measures from timestamp pairs; zero-config introspection with lockfile and `composer.yaml` overrides; saved measure fragments and plan reuse with slot rebinding; fan-out safety; clarification loop.

**Out (v2+):** §5.17, cross-column OR beyond one pair, multiple HAVING predicates, multi-step questions requiring a plan to feed another plan beyond §5.16.

---

## 12. Open decisions

1. **Promotion to canonical.** Who in the host app can promote a saved definition from user scope to org-canonical, and whether conflicting canonical definitions are allowed at all or blocked at promotion.
2. **Schema size.** Tables and columns per tenant determine whether R0 is needed and whether hierarchical column selection is required.
3. **Calendar conventions.** Week start, fiscal year, and the house default for "last quarter" / "last month" (calendar vs trailing).
4. **Value index refresh.** How often distinct values are re-indexed, and which high-cardinality columns are trigram-searchable (cost vs recall).
5. **Model hosting.** Jev API vs a self-hosted equivalent behind §9's interface, given what R1 state contains.
6. **Default limits and banners.** Auto-execute thresholds and what the user sees for execute-with-banner vs clarify.
