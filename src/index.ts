/**
 * jev-query — plug-and-play natural language → PostgreSQL.
 *
 * The model never writes SQL. Code enumerates the legal moves of a typed QueryPlan,
 * a decision model (Jev, or any `Oracle`) picks among them with calibrated
 * probabilities, and code compiles the plan to parameterized Postgres.
 */
export { Composer, QueryTooExpensiveError } from "./composer.js";
export type { ComposeContext, ComposerOptions, Result, Clarification, ClarifyOption, RoundLog } from "./composer.js";

export { parseConfig, resolveSettings } from "./config.js";
export type { ComposerConfig, ResolvedSettings } from "./config.js";

export type { Db, QueryResult } from "./db/types.js";
export { fromPg } from "./db/pg.js";
export { fromPGlite } from "./db/pglite.js";
export { openDb } from "./db/open.js";

export type { Oracle, Question, Questions, Answer, Answers, ChoiceQuestion, ScoreQuestion, NoulQuestion, ChoiceAnswer, ScoreAnswer, NoulAnswer } from "./oracle/types.js";
export { JevOracle, type JevOracleOptions } from "./oracle/jev.js";
export { LogprobOracle, type LogprobOracleOptions } from "./oracle/logprob.js";
export { HeuristicOracle } from "./oracle/heuristic.js";
export { CachingOracle, RecordingOracle } from "./oracle/cache.js";

export { introspect, type RawCatalog, type IntrospectOptions } from "./schema/introspect.js";
export { buildSchemaModel } from "./schema/conventions.js";
export { writeLockfile, readLockfile, isStale } from "./schema/lockfile.js";
export { doctor } from "./schema/doctor.js";
export type { SchemaModel, TableModel, ColumnModel, Relationship, ColumnRole } from "./schema/model.js";

export type { QueryPlan, Measure, Dimension, Predicate, Existence, Decision, Shape, Agg, Op } from "./plan/types.js";
export { compile, CompileError, type Compiled, type OutputColumn } from "./sql/compile.js";
export { narrate } from "./sql/narrative.js";

export { MemoryStore, PgStore } from "./saved/store.js";
export type { SavedQueryStore, SavedRecord, SavedMeasure, SavedPlan } from "./saved/types.js";

export { periodBounds, PERIOD_KEYS, type PeriodKey, type Bounds } from "./time/periods.js";
export { extractSpans, type Span } from "./nl/spans.js";
export { linkValues, type ValueLink } from "./nl/link.js";
