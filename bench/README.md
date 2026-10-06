# Unseen-schema benchmarks

Zero-config accuracy on public sample databases the composer was not designed around (spec §10,
"Unseen schemas"). Each benchmark has a `cases.yaml` (same format as `testbed/eval/cases.yaml`) and
a `composer.yaml` that sets only `as_of` and the timezone, so runs are deterministic.

| Benchmark | Domain | Naming style | Source | License |
|---|---|---|---|---|
| `chinook` | digital music store | singular snake_case tables, `album_id` keys | [lerocha/chinook-database](https://github.com/lerocha/chinook-database) | MIT |
| `northwind` | trading company | plural tables, character-code keys | [pthom/northwind_psql](https://github.com/pthom/northwind_psql) | MIT (Microsoft sample data) |
| `pagila` | DVD rental | partitioned `payment` with no FKs, triggers, domains | [devrimgunduz/pagila](https://github.com/devrimgunduz/pagila) | PostgreSQL License |

The database dumps are downloaded at load time into `.datasets/` and are not committed. Pagila's
recent `film_embedding` table needs pgvector and is skipped (it is not part of classic Pagila).

```bash
npx tsx scripts/load-unseen.ts                 # downloads and loads all three into .unseen-db/<name>
npx jev-query eval --bench chinook --verify-gold   # check gold SQL (row counts, ties at LIMIT)
npx jev-query eval --bench chinook --oracle jev --cache .jev-cache --explain
```

## Results (Jev, `jev-latest`)

| | Chinook | Northwind | Pagila | Total |
|---|---|---|---|---|
| Zero-config baseline (code as of the v1 merge) | 11/18 | 14/18 | 14/18 | **39/54** |
| After convention and composer fixes | 17/18 | 18/18 | 17/18 | **52/54** |

The baseline was run before any change for these schemas. The fixes are general rules (see
"What changed" below), but they were developed while looking at these failures, so the second row is
optimistic; a fourth unseen schema would be the next honest check. One case was changed after the
first run (NW05: keyed on `company_name` instead of `customer_id`, because the composer showed the
right three companies by name and the case had keyed an arbitrary id column); without that change
the total is 51/54.

Remaining failures are both clarifications, not wrong answers:

- **CH14** "How many tracks were sold in 2025?": units sold vs distinct tracks sold. Both match gold in
  this data, but they are different queries, so the composer asks.
- **PG08** "Customers who have never rented a film": Jev judges "a film" not reflected in "customers that
  have no rental", so the coverage check asks.

What changed between the two rows:

- Conventions: person tables are displayed by first + last name (not job `title`); `company_name` and
  unique `*_name` columns are display columns; birth dates are PII attributes, not event times;
  `last_update`-style columns are audit columns (which also makes `film_category`/`film_actor` junctions);
  integer 0/1 columns are flags; short `*_description` columns are names; `milliseconds` is a duration.
- Composer: absence looks through up to three 1:N hops ("films never rented" via inventory), filters inside
  `NOT EXISTS` keep the user's polarity, one word maps to one boolean column, two dimensions with the
  same head noun keep the likelier, "include empty groups" only applies to breakdowns, duration
  thresholds convert units ("10 minutes" → 600000 ms), broader "not yet …ed" null triggers, and coverage
  only treats spans that shaped the plan as handled.
- Compiler: joins inside `EXISTS` may cross 1:N steps; timezone-naive timestamps are truncated as
  wall-clock; entity output includes the id when names don't identify a row; the narrative describes
  conditions inside `EXISTS`.
- Harness: evals run with `TZ=UTC` (PGlite parses `timestamp without time zone` in the process timezone).

## How the cases were written

The 54 cases were written as ordinary user questions before any composer change for these
schemas, then each gold query was checked against the data (`--verify-gold` flags empty results
and ties at a `LIMIT` boundary; two cases were reworded because of ties). They deliberately include
things v1 cannot compose, where the correct outcome is to ask or decline: arithmetic between
columns (Northwind revenue), comparisons between two columns (late shipments), self-joins (who
reports to whom), and names split across first/last name columns.
