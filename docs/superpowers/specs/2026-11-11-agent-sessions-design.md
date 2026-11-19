# Agent trajectories in Nereus: model, import, pages and judgments

Date: 2026-11-11, revised 2026-11-17 after the prototype walk, 2026-11-19 after sub-project 1 and
after sub-project 2.
Status: sub-projects 1 and 2 are built; sections on the later sub-projects are design.

The pages of section 8 were settled one function at a time on a clickable prototype with invented
data. Where this document and the prototype differ, this document wins.

## 1. Goal

Nereus stores logs, traces, metrics and browser sessions in Apache Doris. This design adds the
execution trajectories of AI agents as a second kind of data in the same product, following the
vision paper "TrajectoryDB: A New Database for Agent Trajectories" (arXiv 2609.07782).

The work serves three goals, in this order:

1. An internal review demo that shows Doris can carry the scenarios of the paper.
2. An external showcase.
3. Daily use by the team on its own agents.

Coverage of the paper's requirements (section 3 of the paper):

| Requirement | Where | Sub-project |
| --- | --- | --- |
| 3.1.1 Structural retrieval: sessions, steps, roles | Sessions, Steps and Messages pages; session page; Compare; Export | 1 |
| 3.1.2 Sequence retrieval | Sequences page; safety rules and the Risks page | 2 |
| 3.2.1 Semantic and relational operators combined | Judges | 3 |
| 3.2.2 Incremental semantic evaluation | Judges that run on new sessions; memory validity | 3, 4 |
| 3.3.1 Context reconstruction | Deferred by decision on 2026-11-16; the data model keeps it possible (5.4) | later |
| 3.3.2 Lineage of semantic judgments | Judge versions, out-of-date verdicts, reruns | 3 |

The work is split into sub-projects. Sections 2 and 3 fix what they all share; sections 4 to 12
specify sub-projects 1 to 5. Each of those gets its own implementation plan.

| # | Sub-project | Delivers |
| --- | --- | --- |
| 0 | Environment | A pinned Doris master that Nereus runs and is tested on |
| 1 | Trajectories | The agent tables, the Claude Code importer, Sessions, Steps, Messages, the session page, Compare, Export, SQL |
| 2 | Sequences and risks | The Sequences page, safety rules, `agent_risks`, the Risks page and column |
| 3 | Judges and lineage | Judges, their versions and verdicts, reruns; model judgments of risks |
| 4 | Memories | Capture of agent memories, the Memories page, memory validity; trajectory tools for agents |
| 5 | Dashboard | The built-in agent dashboard |
| 6 | Live capture | OTLP ingestion; trajectories grow while the agent runs |
| 7 | External demo pack | Public data, offline demo build, guided stories |
| 8 | Hardening | Retention, scale, alerts on risks and verdicts |

Nereus is a young project. Compatibility with earlier Nereus versions is not a constraint: code
may be restructured and the whole stack moves to Doris master.

## 2. Layers

```
Capture     OTLP GenAI spans · Claude Code transcripts · agent memory stores · browser SDK · Collector
              | telemetry goes straight to Doris        | agent content goes through the semantics layer
Product     search · charts · alerts · the agent pages
Semantics   normalisation · trajectory operations, patterns and rules compiled to SQL · judges
Database    Doris master: tables and sort keys · indexes · window, sequence and recursive queries
Control     PostgreSQL: users, configuration, current judge versions, job leases
```

Dependencies point downwards only: the product layer calls the semantics layer, which calls the
database layer.

Five rules decide where a capability lives.

1. **Facts and set operations belong to the database.** Anything deterministic, set-oriented and
   expressible in SQL runs in Doris. The application does not join, aggregate, sort or match
   patterns in memory.
2. **Meaning and procedure belong to the semantics layer.** Format-specific parsing, stateful
   per-record processing, calls to external models, and execution with budgets and retries run in
   the application.
3. **The semantics layer keeps no private data.** Its inputs and outputs are tables in Doris. Its
   job is to compile trajectory-level operations to SQL, as the existing search compiler does.
4. **Control plane and data plane are separate.** Configuration, identity and job leases are in
   PostgreSQL. Trajectory facts, derived state and telemetry are in Doris, so a lineage question is
   answered with SQL alone.
5. **Push-down needs evidence.** An application-layer capability moves into Doris only when it is
   a measured bottleneck and its semantics are stable. Interfaces stay "tables in, tables out", so
   a push-down does not change the layers above.

Two exceptions to rule 1 were measured or reasoned on the prototype and are allowed: pairing the
steps of two sessions for Compare (an alignment, not a set operation) and assembling export lines
from rows already fetched.

Placement of the paper's capabilities:

| Capability in the paper | Database layer | Semantics layer |
| --- | --- | --- |
| Structure: session tree, turn, step, message, role | Stores structure as columns and keys; a session is stored contiguously; retrieval is a range scan or a recursive CTE | Defines the structure; computes ids, sequence numbers and tree links at ingestion |
| Reconstructing structure at ingestion (C1) | Holds the state reconstruction needs, readable by key | Canonicalises, hashes, diffs, assigns sequence numbers |
| Redundant context (C4) | Stores and compresses | Removes redundancy by modelling: each content block is written once, a request stores references |
| Physical layout (C3) | Sort keys, inverted indexes | Declares DDL only |
| Sequence retrieval and order (3.1.2, C5) | Runs the match with window functions and joins on position | Pattern language, rules, their compiler to SQL |
| Semantic operators (3.2.1) | Picks the steps, assembles what the model reads, stores verdicts, runs the queries after | Judge definitions, model calls, output validation |
| Incremental semantic evaluation (3.2.2) | Answers "what is new since the last verdict or state"; stores states as versions | Runs the judge or the fold; writes results idempotently |
| Lineage of judgments (3.3.2, C7) | Verdicts carry their judge version and inputs; "out of date" and "changed" are SQL | Writes provenance at execution; offers reruns |
| Telemetry and its link to behaviour | Log, trace and metric tables; joins by trace and span id or by time | Not involved |

Deliberately placed in no layer for now: engine-level prefix-aware compression (replaced by
modelling), order as an optimizer property, `MATCH_RECOGNIZE`, optimizer-level co-optimisation of
semantic and relational operators, and the scheduling use case of the paper. Rule 5 applies.

## 3. Decisions that bind all sub-projects

- **The model only judges.** A judge is a criterion answered by a model about one item. Which
  items are judged, what the model reads, storing the verdicts and every query on them are SQL in
  Doris. The model is called by the semantics layer, not through Doris AI functions. There are two
  forms: `map` (per step, stateless) and `fold` (per subject, a state updated with each new piece
  of evidence). Judge versions are immutable rows in Doris; the current version and schedule of a
  judge are in PostgreSQL.
- **Nereus does not write memories.** Agents and people write them. Nereus captures them, shows
  where they came from as far as it is recorded, and judges whether they still hold.
- **Never present inferred provenance as fact.** What is recorded is shown as recorded; what is
  guessed is marked as inferred with its score; what is unknown says "Not recorded".
- **The database decides which work is due; the semantics layer does the work.** Cache hits,
  "sessions with new events" and "verdicts out of date" are set operations computed in SQL.
- **Observability and agent data are one product.** Telemetry does not pass through the semantics
  layer. Agent tables are registered as Nereus query sources, so search, charts, dashboards and
  alerts work on them. Agent events carry trace and span ids.
- **Product concepts on screen, not storage forms.** Pages speak of agents, sessions, steps,
  messages, memories and judges, never of one runtime's files or tables.
- **Experimental Doris features stay at the edges.** The core model does not depend on changelog,
  table streams or incremental materialized views.

## 4. Scope

Sub-projects 1 to 5 as listed in section 1, with these limits:

- Capture sources: Claude Code transcripts, and the memory stores of Claude Code and Gemini CLI.
- Safety rules are defined in code (four rules, 8.6); editing rules on a page is out of scope.
- Every verdict comes from a real model call; the prototype's verdicts were simulated.
- Out of scope: context reconstruction (3.3.1) and its "where did this message go" view, forks
  drawn on the session page, comparing more than two sessions, custom dashboards and group-by,
  alerts, cost in currency, saved views, safety drift and fault grouping (other 3.2.2 scenarios),
  invalidation of verdicts when a source trajectory changes, OTLP ingestion.

## 5. Data model

All tables are unique-key tables with merge-on-write. Keys come from the capture source or from
the judge, so writing the same thing twice yields the same rows. No table enables changelog:
trajectories are append-only and carry their own sequence numbers, so "the state at a version" is
a prefix by `seq` and "what is new" is a comparison with `last_seq`. Changelog on Doris master can
be set only at table creation, rejects VARIANT columns and rejects `DELETE` with a predicate.

`role` and `system` are reserved words on Doris master. Columns are therefore named `msg_role`
and `system_text`.

One **session** is one linear branch: a main session, a sub-agent, or a fork. Inside a branch `seq`
is a total order. Across branches only the spawn point orders events, which is the partial order
the paper describes. A row of the Sessions page is a main session with its tree.

One **step** is one model call and the tool calls it issued. One **turn** starts at a user input.

One **content block** is one row of `agent_messages`: a text, a tool call, a tool result, a
thinking block, a compaction summary or an injected attachment. Blocks of one API message share
`api_msg`. A tool-call event, its tool-use block and its tool-result block correspond one to one.

One **context range** is one row of `agent_contexts`: a run of consecutive blocks that a model call
saw. After a compaction the context is the summary block plus one range. When a call's context is
not a pure append, the runs that the previous call saw and this call no longer does are stored too,
marked as dropped.

### 5.1 `agent_sessions`

`UNIQUE KEY (session_id)`, not partitioned, `DISTRIBUTED BY HASH (session_id) BUCKETS AUTO`.

| Column | Type | Meaning |
| --- | --- | --- |
| `session_id` | VARCHAR(128) NOT NULL | Branch id |
| `root_id` | VARCHAR(128) NOT NULL | Id of the main session of the tree |
| `parent_id` | VARCHAR(128) | Parent branch; NULL for a main session |
| `parent_seq` | BIGINT | Event in the parent branch that spawned this branch |
| `kind` | VARCHAR(16) NOT NULL | `main`, `subagent` or `fork` |
| `title`, `agent_name` | STRING, VARCHAR(256) | Display names |
| `runtime`, `runtime_version` | VARCHAR(64) | For example `claude-code`, `2.1.322` |
| `service_name`, `user_id` | VARCHAR(256) | As in the telemetry tables |
| `model` | VARCHAR(128) | Model of the first model call |
| `config` | VARIANT | Execution configuration: sampling parameters, effort, tool names |
| `started_at`, `last_event_at` | DATETIME(6) NOT NULL | Time range of the branch |
| `last_seq`, `last_msg_seq` | BIGINT NOT NULL | Highest sequence numbers written |
| `turns`, `steps`, `tool_calls`, `tool_errors`, `subagents`, `compactions` | INT | Counts |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | BIGINT | Usage sums |
| `peak_ctx_tokens` | BIGINT | Largest context of one request |
| `active_us` | BIGINT | Span minus the gaps before user inputs |
| `first_input`, `last_output` | STRING | First user text and last assistant text, cut to 2,000 characters |
| `safety_risks` | INT | Rows in `agent_risks`, written by the rules job; NULL until sub-project 2 |
| `source` | VARCHAR(32) NOT NULL | `claude-transcript` for now |
| `source_cursor` | STRING | Last source row processed, for incremental import |

On a `main` row the counts and sums cover the whole tree, sub-agents included, except `turns`,
which counts the main branch. On other rows they cover the branch. The writer recomputes them with
one aggregate over `agent_events` after each import batch, so the Sessions page filters and sorts
on stored columns.

Inverted indexes: `root_id`, `parent_id`, `kind`, `runtime`, `model`, `service_name`, `user_id`,
and tokenized indexes on `title`, `first_input` and `last_output`.

### 5.2 `agent_events`

`UNIQUE KEY (session_id, seq, ts)`, `AUTO PARTITION BY RANGE (date_trunc(ts, 'day'))`,
`DISTRIBUTED BY HASH (session_id) BUCKETS AUTO`.

| Column | Type | Meaning |
| --- | --- | --- |
| `session_id`, `seq`, `ts` | VARCHAR(128), BIGINT, DATETIME(6), NOT NULL | Key; `ts` is the start time |
| `turn`, `step` | INT NOT NULL | Turn number, from 1; ordinal of the latest model call at or before the event, 0 before the first |
| `kind` | VARCHAR(24) NOT NULL | `user_input`, `llm_call`, `tool_call`, `compaction`, `error`, `note` |
| `parent_seq` | BIGINT | For a tool call, the model call that issued it |
| `name` | VARCHAR(256) | Tool name, or model name for a model call |
| `status`, `error` | VARCHAR(16), STRING | `ok`, `error` or empty; error text |
| `end_ts`, `duration_us`, `ttft_us` | DATETIME(6), BIGINT, BIGINT | Timing |
| `gap_us` | BIGINT | Time between the end of the previous event of the branch and the start of this one |
| `model`, `stop_reason`, `request_id`, `attempt` | VARCHAR, VARCHAR, VARCHAR, INT | Model call details; retry attempt |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | BIGINT | Usage as reported |
| `ctx_msgs`, `ctx_prefix` | INT | Blocks in the context; leading blocks shared with the previous call |
| `ctx_change` | VARCHAR(16) | `fresh`, `append`, `truncate`, `compact` |
| `ctx_exact` | BOOLEAN | True when the context comes from a request log, false when inferred |
| `prompt_hash` | VARCHAR(64) | System prompt and tool definitions of this call |
| `msg_seq`, `result_msg` | BIGINT | The block the event names: an input's text, a tool call's block, and for a model call the first text it wrote, or its first block when it wrote none; tool-result block |
| `tool_call_id` | VARCHAR(128) | Provider id of the tool call |
| `resource` | STRING | The object the tool call acts on: file path, URL or command |
| `args` | VARIANT | Tool arguments |
| `args_hash` | VARCHAR(32) | Hash of the tool name and the canonical arguments |
| `repeat_of` | BIGINT | Earliest earlier tool call of the session with the same `args_hash` |
| `repeat_visible` | BOOLEAN | Whether the result of that earlier call was still in the context of the model call that issued this one |
| `trace_id`, `span_id` | VARCHAR(64), VARCHAR(32) | Link to telemetry |
| `attrs` | VARIANT | Other attributes |

Inverted indexes: `kind`, `name`, `status`, `model`, `request_id`, `trace_id`, `resource`
(untokenized), `args`, `attrs`.

### 5.3 `agent_messages`

`UNIQUE KEY (session_id, msg_seq, ts)`, daily auto partition on `ts`, hash distribution on
`session_id`. `storage_page_size` starts at 262144 and is tuned by the measurement in section 12.

| Column | Type | Meaning |
| --- | --- | --- |
| `session_id`, `msg_seq`, `ts` | VARCHAR(128), BIGINT, DATETIME(6), NOT NULL | Key; `ts` is when the block was first seen |
| `content_hash` | VARCHAR(64) NOT NULL | SHA-256 of the canonical block |
| `msg_role` | VARCHAR(16) NOT NULL | `system`, `user`, `assistant`, `tool` |
| `kind` | VARCHAR(24) NOT NULL | `text`, `tool_use`, `tool_result`, `thinking`, `summary`, `attachment` |
| `api_msg` | INT NOT NULL | Ordinal of the API message the block belongs to |
| `event_seq` | BIGINT | Event that produced the block |
| `tool_name`, `tool_call_id`, `is_error` | VARCHAR(256), VARCHAR(128), BOOLEAN | For tool-use and tool-result blocks |
| `bytes`, `tokens` | INT | Size; token estimate, bytes divided by four |
| `truncated` | BOOLEAN | True when `text` was cut at the single-value limit |
| `text` | STRING | Readable text of the block |
| `payload` | VARIANT | Structured part: tool input, non-text content |

Inverted indexes: `msg_role`, `kind`, `tool_name`, `content_hash`, and a tokenized index with phrase
support on `text`.

### 5.4 `agent_contexts`

`UNIQUE KEY (session_id, seq, rel, pos, ts)`, daily auto partition on `ts`, hash distribution on
`session_id`. `seq` and `ts` are those of the model-call event. Columns besides the key:
`from_msg BIGINT NOT NULL`, `to_msg BIGINT NOT NULL`, both inclusive. `rel VARCHAR(4)` is `in` for a
run the call saw and `out` for a run the previous call saw and this one does not. `out` rows exist
only for calls whose `ctx_change` is not `append`. The step view's input ("what the model saw") and
a later context reconstruction both read this table.

### 5.5 `agent_prompts`

`UNIQUE KEY (prompt_hash)`, not partitioned. One row per distinct system prompt plus tool
definitions: `prompt_hash VARCHAR(64) NOT NULL`, `system_text STRING`, `tools VARIANT`,
`tool_names ARRAY<STRING>`, `bytes INT`, `first_seen DATETIME(6)`. It is the first message of a
step's input and of every exported conversation.

### 5.6 `agent_risks`

Written by the rules job (6.5), which replaces the rows of a tree each time it runs on it.
`UNIQUE KEY (session_id, rule, first_seq)`, hash distribution on `session_id`.

| Column | Type | Meaning |
| --- | --- | --- |
| `session_id`, `rule`, `first_seq` | VARCHAR(128), VARCHAR(64), BIGINT, NOT NULL | Key: the branch, the rule id, and the event the risk is keyed by: the first event of an order, or the command that needed a confirmation |
| `rule_version` | INT NOT NULL | Version of the rule's code that found it |
| `rule_name` | STRING | The rule's name when it found the risk, so the tables can show and search it |
| `root_id` | VARCHAR(128) NOT NULL | For the Sessions page |
| `ts`, `turn` | DATETIME(6), INT | Of the event `first_seq` names |
| `events` | ARRAY<BIGINT> | The `seq` of every event of the risk; for a command that needed a confirmation, the user's last input comes first |
| `steps` | VARIANT | Those events as the risk view shows them: kind, turn, step, the model call of a tool call, name, status, target |
| `what` | STRING | The events in words, joined by arrows |
| `why` | STRING | The sentence filled from the rule's template and the events |
| `found_at` | DATETIME(6) | When the job wrote it |

Inverted indexes: `rule`, `root_id`, and tokenized indexes on `rule_name` and `what`.

The risks of a tree are read only while its main session has a count in `safety_risks`. An import
unsets the count, so risks that point at the events of an earlier import are not shown.

### 5.7 `agent_judges`

One row per judge version, never updated. `UNIQUE KEY (judge, version)`, not partitioned.

| Column | Type | Meaning |
| --- | --- | --- |
| `judge`, `version` | VARCHAR(64), INT, NOT NULL | Key |
| `name` | STRING | Display name |
| `form` | VARCHAR(8) | `map` or `fold` |
| `pick` | VARIANT | What is judged: tool, target words, result; or for a fold the subject kind |
| `reads` | VARIANT | What the model reads: `step`, `before` with N, or `turn` |
| `criterion` | STRING | The question the model answers |
| `model` | VARCHAR(128) | Model id |
| `created_at`, `created_by` | DATETIME(6), VARCHAR(256) | Who saved the version and when |

A new version is written when the criterion, the model or what the model reads changes. Name and
schedule changes are control-plane edits in PostgreSQL and make no version.

### 5.8 `agent_judgments`

Verdicts of map judges and states of fold judges. `UNIQUE KEY (judge, subject, judge_version,
version)`, not partitioned, hash distribution on `subject`.

| Column | Type | Meaning |
| --- | --- | --- |
| `judge`, `subject`, `judge_version`, `version` | VARCHAR(64), VARCHAR(256), INT, INT, NOT NULL | Key. A map judge's subject is `<session_id>:<seq>` and `version` is 1; a fold's subject is what it follows (a memory id), and `version` counts its updates |
| `session_id`, `seq` | VARCHAR(128), BIGINT | The judged step; for a fold, the step that brought the evidence |
| `verdict` | VARCHAR(16) | Map: `violates`, `ok`, `unsure` |
| `state`, `evidence`, `prev_version` | VARCHAR(16), VARCHAR(16), INT | Fold: state after the update, `supports`/`conflicts`/`none`, the version it started from |
| `reason` | STRING | The model's reason |
| `input_seqs` | ARRAY<BIGINT> | Events the model read |
| `input_hash` | VARCHAR(64) | Hash of what the model read, for reuse |
| `model`, `input_tokens`, `output_tokens` | VARCHAR(128), INT, INT | The call |
| `judged_at` | DATETIME(6) NOT NULL | When |

A rerun adds rows with the new `judge_version`; older rows stay. A step's current verdict is the
row with the highest `judge_version`. A verdict is **out of date** when that is lower than the
judge's current version. These are SQL predicates (`max_by`, `lag()` for "changed by a rerun").

Risk judgments are a map judge per rule whose subject is the risk (`<session_id>:<rule>:<first_seq>`).

### 5.9 `agent_memories`

One row per captured version of a memory. `UNIQUE KEY (agent, scope, name, captured_at)`, not
partitioned.

| Column | Type | Meaning |
| --- | --- | --- |
| `agent`, `scope`, `name`, `captured_at` | VARCHAR(64), VARCHAR(256), VARCHAR(256), DATETIME(6), NOT NULL | Key. Agent such as `claude-code`; scope such as a project or `global`; name in the agent's own format |
| `format` | VARCHAR(32) | `claude-auto-memory`, `gemini-md`, … |
| `location` | STRING | Where the agent keeps it (a path); not shown on pages, used to find sessions that read it |
| `description`, `kind` | STRING, VARCHAR(32) | Shared parts; kind as the agent names it (`feedback`, `project`, …) |
| `content` | STRING | Body |
| `sections` | VARIANT | Body split by the format's own headings |
| `fields` | VARIANT | The format's own metadata, unchanged |
| `content_hash` | VARCHAR(64) | A new row is written only when it changes |
| `updated_at` | DATETIME(6) | Time from the format (`modified`) or the file |
| `source_session_id` | VARCHAR(128) | Recorded origin (Claude Code `originSessionId`) or inferred |
| `source_kind`, `source_score` | VARCHAR(16), FLOAT | `recorded`, `inferred` or `none`; for inferred, the share of the memory's words found |

Inference: the memory's words, without common words and headings, are matched against the first
input and the assistant text of sessions of the same agent before `updated_at`; the best session
over 50 % is recorded as inferred. Pages always show the kind and the score.

As built (capture): a memory's words are those of four or more letters and digits (CJK text is not
matched), at most 40, and a memory of fewer than five is not matched; a word counts once it is
found as a whole word in the first input or an assistant text block of a main session of the agent.
A memory gone from its store gets a row whose `content_hash` is `removed`, and the pages leave it
out. A store is one agent's memories of one scope: a Claude Code project folder, or one
`GEMINI.md` (`global` for the user's own); it is captured under a lease by
`node src/cli/capture-memories.ts`. Gemini CLI memories are named by the first 200 characters of
their bullet, so an edited bullet is a new memory and the old one is removed.

### 5.10 Retention and sources

The partitioned tables take a retention parameter of their own (`AGENT_RETENTION_DAYS`).
`agent_sessions`, `agent_events`, `agent_messages` and `agent_risks` are registered in
`semantics/search/source.ts` as query sources.

## 6. Capture, normalisation and jobs

Import has three stages.

| Stage | Does | Nature |
| --- | --- | --- |
| Adapter | Reads one capture format into neutral capture records | One per format; knows the format, makes no decisions |
| Normaliser | Assigns sequence numbers, hashes and deduplicates blocks, computes context ranges and change type, numbers turns and steps, extracts `resource` | Pure functions, no I/O |
| Writer | Writes rows to Doris in batches by key; updates `agent_sessions` last | Idempotent |

### 6.1 Capture records

The adapter emits records of these kinds, in source order per session:

- `session`: id, parent session id and the id of the tool call that spawned it, kind, title, runtime
  and version, start time.
- `block`: native id, role, kind, id of the API message, text, payload, tool name, tool call id,
  error flag, time.
- `call`: id of the API message, request id, model, time, usage, stop reason, prompt hash, and,
  when the source logs requests, the context delta: `base` request id, `keep` and `tail`.
- `compaction`: time, trigger, token counts before and after, preserved blocks, the summary block.
- `error`: time, message, attempt, maximum attempts, delay before retry.
- `turn_end`: duration.
- `prompt`: hash, system text, tool definitions.

### 6.2 Normaliser rules

- **Block identity.** `content_hash` is the SHA-256 of role, kind and canonical content. Canonical
  content is the block's text, or its JSON with sorted keys. A tool-use or tool-result block also
  takes its call id, so two identical calls stay two blocks. Within a session, a block whose hash
  is already known keeps its `msg_seq`; a new hash gets `last_msg_seq + 1`.
- **Events.** A user prompt opens a turn and becomes a `user_input` event. The blocks of one API
  message become one `llm_call` event, which names the first text block among them; `step`
  increases by one. Each tool-use block becomes a
  `tool_call` event whose `parent_seq` is that model call. The matching tool-result block sets
  `status`, `end_ts`, `duration_us` and `result_msg` on the same key. A compaction record becomes a
  `compaction` event and its summary is a block of kind `summary`. An error record becomes an
  `error` event with its `attempt`. A turn-end record sets `end_ts` and `duration_us` on the
  `user_input` event of the turn.
- **Context.** With a request log, the context of a call is the first `keep` blocks of the base
  call's context followed by the tail blocks. Without one, it is every block of the branch since
  the last compaction, and `ctx_exact` is false. The block list is stored as ranges.
- **Change type.** `fresh` when there is no base; `compact` for the first call after a compaction;
  `append` when `keep` equals the length of the base context; `truncate` when it is smaller.
- **Dropped ranges.** For a call that is not an append, the ranges of the previous context that
  are absent from the new one are written with `rel = 'out'`. Without a request log, the dropped
  ranges of a compaction are every block before it except the ones its metadata lists as preserved.
- **Repeats.** `args_hash` is computed for every tool call. If an earlier tool call of the session
  has the same hash, `repeat_of` is its `seq`, and `repeat_visible` says whether that call's result
  block is in the context of the model call that issued the repeat.
- **Resource.** A rule per tool name selects the argument that names the object acted on
  (`file_path` for file tools, `url` for fetch tools, the command for shell tools). Tools without a
  rule leave `resource` NULL.
- **Sub-agents.** A session record with a parent becomes a `subagent` branch; `parent_seq` is the
  `seq` of the tool-call event whose result carries the same agent id.
- **Branches.** A source whose rows form a tree is cut into linear branches. A second
  conversational child of one parent starts a `fork` branch. Parallel tool calls are not forks.
- **Gaps.** `gap_us` is the start of an event minus the end of the previous event of the branch;
  it is 0 for the first event. Active time is the span of a session minus the gaps of its
  `user_input` events.
- **State.** The normaliser needs, per session, the map from hash to `msg_seq`, the last sequence
  numbers, the open tool calls and the ranges of the last call. The transcript importer reads a
  file whole each time, so this state starts empty and none is read from Doris. A capture path
  that appends (sub-project 6) will have to hold or reload it.

### 6.3 Claude Code transcript adapter

Field names below were checked on local transcripts of versions 2.1.290 to 2.1.322.

| Source | Becomes |
| --- | --- |
| Main file `<session>.jsonl` | Main session; title from the `ai-title` row |
| `<session>/subagents/*.jsonl` | Sub-agent sessions; linked through `agentId` in the parent's tool result |
| `assistant` rows (one block each; `message.id`, `apiBlockIndex`, `requestId`, `usage`) | Blocks, and one `call` per `message.id` |
| `user` rows with text | A `user_input` block |
| `user` rows with `tool_result` (`tool_use_id`, `sourceToolAssistantUUID`, `is_error`) | Tool-result blocks |
| `attachment` rows | Blocks of kind `attachment` |
| `system` rows, subtype `compact_boundary` with `compactMetadata` | `compaction` |
| `system` rows, subtype `api_error` (`retryAttempt`, `maxRetries`, `retryInMs`) | `error` |
| `system` rows, subtype `turn_duration` | `turn_end` |
| `api-request` rows (`id`, `base`, `keep`, `tail`, `shapeHash`) | Context delta and prompt hash of a `call` |
| `api-request-blob` rows (`hash`, `message`) | Blocks the request added that appear in no other row |
| `api-request-shape` rows (`shapeHash`, `shape.system`, `shape.tools`) | `prompt` |

Versions before 2.1.302 have no request log; their contexts are inferred. Row types the adapter
does not know are counted and skipped. A malformed line is skipped and reported.

### 6.4 Idempotency, increments and limits

- Session ids come from file names; sequence numbers come from the deterministic row order, so a
  full re-import produces the same keys.
- `source_cursor` holds the size and modification time of the source file. A file whose cursor is
  unchanged is skipped. A changed file is read whole again: the rows of its tree are deleted and
  loaded again, which yields the same keys.
- Text longer than the Doris single-value limit (`string_type_length_soft_limit_bytes`, 10 MB by
  default) is cut and `truncated` is set; the full text stays in the source file.
- The writer uses Stream Load with a label per table, session, batch and import run, and the
  unique keys make a retried row harmless.
- The importer connects with its own Doris account that can write only the fact tables. The jobs
  of 6.5 use a second account that can write only the derived tables. The API service is read-only
  on all agent tables; actions that write (a new judge, a rerun) enqueue a job.

Entry point: `node src/cli/import-transcripts.ts <dir-or-file>...`.

### 6.5 Jobs

Jobs run in the semantics layer, take a lease in PostgreSQL per unit of work, and find their work
with SQL.

| Job | Due work (SQL) | Does | Writes |
| --- | --- | --- | --- |
| Rules | Main sessions whose `safety_risks` is unset: an import unsets it, the job sets it | Runs the four rule statements (8.6) on the sessions of each such tree, replaces the tree's risks, then writes the counts | `agent_risks`; `safety_risks` |
| Judge run | Picked steps without a verdict of the requested version, limited to the run's set | Builds what the model reads, calls the model with a token budget, validates the answer | `agent_judgments` |
| Judge on new sessions | For judges set to run on new sessions: picked steps of sessions imported since the judge's cursor | As above, with the current version | `agent_judgments` |
| Risk judgment | Risks without a judgment of the rule judge's current version | Model judgment of the candidate (rules find, the model decides) | `agent_judgments` |
| Memory capture | Not SQL: one adapter per memory format reads the stores | Splits by the format's sections; writes a row when the content hash changes; infers the source if not recorded | `agent_memories` |
| Memory validity | Sessions with a recorded read of the memory's `location` after the latest state | Fold: previous state plus one new session, oldest first | `agent_judgments` (judge `memory-validity`) |

A lease is a row of `job_leases` in PostgreSQL (job, unit, holder, expiry); for the rules job a unit
is a session tree. A runner takes the lease before it works on a tree and gives it back after; a
lease that has expired can be taken by anyone. Once it holds the lease, a runner checks that the
tree is still due, so a tree another runner finished meanwhile is not run twice. A tree whose run
fails is named and stays due; the job goes on with the others and exits with 1. The rules job
runs from the command line: `node src/cli/run-rules.ts`, with `--all` to run the rules on every
tree again.

The judge runs keep their own queue, the rows of `judge_runs`, and run from
`node src/cli/run-judges.ts`, which first queues a run of the new steps of every judge that
follows new sessions.

A model call that fails is retried with backoff; after the last attempt the step gets `unsure`
with the error as reason. Every run records its token counts. The default model is
`claude-haiku-5-5`. As built, the key is not kept in PostgreSQL: the Anthropic SDK reads it from
the environment of the command and of the API service.

Memory adapters: Claude Code auto memory (`~/.claude/projects/*/memory/*.md`: frontmatter `name`,
`description`, `metadata.type`, `originSessionId`, `modified`; `MEMORY.md` is the index and not a
memory), and Gemini CLI (`GEMINI.md` tiers; one memory per bullet under "## Gemini Added
Memories", no metadata). Validity can only be judged for formats whose reads are recorded as
events; for a memory loaded whole into every session the page says "Use not recorded".

## 7. Operations and API

Each operation is a function in `semantics/trajectory/` that returns SQL and a row mapper, in the
style of `traceSql`. Endpoints follow the Nereus conventions: every response carries the SQL that
ran and the elapsed time, which the SQL dialog shows.

Table pages share one request shape: time range (`from`, `to`), search `q` (all words must match,
quotes make a phrase), conditions `f=<column>:<op>:<value>` joined by AND, `sort`, `dir`, `limit`
(100) and `offset`, and `format=csv|jsonl` for export, which applies the same filter to every
matching row. With `size=1` an export answers its size, a preview and its SQL in place of the file.
A CSV export holds at most 200,000 rows and 128 MiB of text, a conversations export at most
128 MiB; a larger one answers 400 and is never cut.

| Operation | SQL shape | Endpoint |
| --- | --- | --- |
| Sessions | Main sessions by `last_event_at` in range; stored columns; search on title, first input, last output | `GET /api/agents/sessions` |
| Steps | `llm_call` events with their tool calls; search joins a derived table of assistant blocks per word | `GET /api/agents/steps` |
| Messages | Blocks with role and kind; `MATCH_PHRASE` on `text` per word | `GET /api/agents/messages` |
| Risks | `agent_risks` of the trees whose rules have run since their last import, as a table page like the others; the judgment is `none` until sub-project 3 joins the verdicts | `GET /api/agents/risks` |
| Session tree and lanes | `WHERE root_id = ?`; one row per turn; the marks (calls that started a sub-agent and compactions first, then failed and repeated calls; at most 2,000, and the answer says when there were more); per step one light row (kind, status, repeat, context size, compaction) when the tree has at most 40 steps; the risks of the tree (at most 500) and, with them, the rules | `GET /api/agents/sessions/<id>` |
| Turn | The user's input and the text of the turn's last model call | `GET /api/agents/sessions/<id>/turns/<n>` |
| Steps of a turn | One page of 100 steps of one turn | `GET /api/agents/sessions/<id>/turns/<n>/steps` |
| Step | Input: context ranges joined with blocks, new blocks first, earlier ones on request; output; tool results | `GET /api/agents/sessions/<id>/steps/<seq>` |
| Compaction | Replaced blocks and the summary | `GET /api/agents/sessions/<id>/events/<seq>/compaction` |
| Compare | Two sessions' facts; turns paired by number; steps of a pair of turns, with their context sizes, paired in the semantics layer; the turn's compactions | `GET /api/agents/compare?a=&b=&turn=` |
| Conversations export | Blocks by session, part number by a window sum over summary blocks; lines assembled in the semantics layer | `GET /api/agents/sessions?format=jsonl` |
| Next calls | From a starting kind of event, `lead()` over the numbered events; every branch of the tree is counted and ranked among the branches of its node in Doris, which answers only the branches the drawing can show | `GET /api/agents/sequences/next?from=&to=&start=&depth=` |
| Tools | The tools called in the range, most called first | `GET /api/agents/sequences/tools?from=&to=` |
| Pattern match | Pattern compiled to CTEs over numbered events, one level per step (next: join on `pos + 1`; later: a window that gives every event the position of the nearest later event meeting the step; later with "same target": join on the target with `min`); the table takes one page of matches, then joins their events once | `POST /api/agents/sequences/match` |
| Judges | Judges with their current version, counts and out-of-date count | `GET /api/agents/judges` |
| Judge | Versions; verdicts, first violation per session, changed by a rerun | `GET /api/agents/judges/<id>?view=first\|all\|changed` |
| New judge | Count of picked steps, a try on 5 sampled steps, the token estimate; then create version 1 and enqueue a run | `POST /api/agents/judges/preview`, `POST /api/agents/judges` |
| New version, rerun | Save a version; enqueue a rerun of all out-of-date verdicts or only the violating ones | `POST /api/agents/judges/<id>/versions`, `POST /api/agents/judges/<id>/reruns` |
| Memories | Latest version per memory, with its validity state | `GET /api/agents/memories` |
| Memory | Fields and sections; source; validity history | `GET /api/agents/memories/<id>` |
| Dashboard | One statement per section over the range and model | `GET /api/agents/dashboard` |

For agents that write memories, the same read operations are offered as two read-only MCP tools,
`trajectory_search` (sessions, steps or messages by search and conditions) and `trajectory_read`
(one session's turns or one step). Their calls are recorded in the agent's own trajectory, which is
how a memory's sources become recorded rather than inferred.

## 8. Pages

### 8.1 Navigation

Agent trajectories are one area of Nereus with its own navigation:

```
Sessions
  Steps
  Messages
  Risks
Sequences
Judges
Memories
Dashboard
```

A page appears in the navigation with the sub-project that builds it: Sessions, Steps and Messages
with sub-project 1, Sequences and Risks with sub-project 2. The app opens on Sessions. In a window too narrow for the navigation's labels,
a table page itself offers its sibling pages.

A page of the navigation replaces whatever is open. Rules for every page:

- List pages are data tables in the convention of observability products, never card lists.
- The time column is the first column; timestamps are `YYYY-MM-DD HH:MM:SS` in a fixed-width face,
  with the time zone shown beside the range.
- One time range (1 hour, 24 hours, 7 days by default, 30 days, custom), one search over the row's
  own text and one "Add filter" (column, comparison, value) per page.
- Sort by one column from its header; a Columns menu; 100 rows at a time.
- Every page has an SQL button that opens "Generated SQL", one read-only section per statement,
  each with Copy.
- State lives in the address.
- Signals (errors, risks, verdicts) are shown on the trajectory pages where the user already is,
  with a click into the detail; no scenario gets a page of its own.

### 8.2 Sessions, Steps, Messages, Risks

**Sessions.** A row is a main session with its tree. Columns, the first nine shown by default:
Last activity (default sort), Session, Errors, Risks, First input, Last output, Turns, Steps,
Tokens; in the menu: Started, Active time, Sub-agents, Compactions, Peak context, Model, User.
Errors counts failed calls. Risks is a red count whose title names the rules; it opens the session
on its first risk. A session on which the rules have not run since its import shows a dash. A session without a title is called by the first line of its first input. A
checkbox column at the far left allows ticking two sessions for Compare. Export writes every
matching session as a table (CSV, database column names, raw values) or as conversations (JSON
lines, 8.4). In a CSV file, free text that a spreadsheet would run as a formula gets a leading
apostrophe.

**Steps.** A row is one step, sub-agents included. Shown: Time, Session, Agent, Turn, Step, Tool
calls, Status, Output, Context, Latency. In the menu: Repeated call ("still in context", "no
longer in context"), Stop reason, Context msgs, New, Context change, Cache hit, Output tokens, Tool
time, Retries, Model. Search runs on what the assistant wrote and called. Output is empty for a
step that only called tools. Export: CSV.

**Messages.** A row is one block. Columns: Time, Session, Agent, Turn, Step, Role, Kind, Tool,
Status, Text, Tokens. Role retrieval (3.1.1) is the condition Role = assistant. A row opens the
session at the step that produced the block. Export: CSV.

**Risks.** A row is one risk. Columns: Time, Session, Agent (hidden), Turn, Judgment, Rule, What
happened; Why it counts in the menu. A row opens the session on that risk.

### 8.3 Session page

Header: the title, one line of facts (turns, steps, tool calls, active time, tokens, peak context,
whether contexts are exact or inferred), "N safety risks", "Wrote memory <name>" when the session
wrote one, and Jump to buttons (failed calls, repeated calls, compactions, sub-agents) shown only
when present. A button visits its places in the order of the tree, a sub-agent's after the call
that started it.

Left: the trajectory drawn after the paper's Figure 1. One lane per session; a numbered node per
turn; a small node per step (filled when it answers, red when a call failed, amber when it repeats
a lookup); a sub-agent as a branch leaving the step that started it (when one step started several,
each has a row of its own under the step, where its lane begins); the lane's width is the
context size of each request, so a compaction shows as a funnel and is a selectable row; a
compaction that ends a turn, or sits in a turn without a model call, has its row even while the turn
is closed. A session
of at most 40 steps opens fully; a longer one opens with turns closed, each closed turn showing its
steps as a chain of tool names (`Read ×2 → Bash failed → …`). Long turns show 100 steps at a time.
Arrow keys move the selection; the page opens on the first turn.

Right: the selected node's own content as a chat, never its children. The assistant speaks from
the left with an avatar and bubbles; the user, tools and sub-agents answer from the right; the
system prompt, compaction notes and summaries are centred notices. A step reads Input (the
messages new in this request, earlier ones folded and opened 100 at a time), Output (the
assistant's text and tool calls) and Tool results (a card per result naming its call, status and
duration). A turn reads the user's input and the final answer. A compaction reads the replaced
messages (folded) and the summary. A risk reads "Safety risk i of N" with the model's judgment,
what happened (the breach's events as buttons that open their step, marked on the left) and the
rule, drawn as a row of steps. A risk is shown in place of the selection and is named in the address
(`risk=<session>:<rule>:<first event>`); the lanes stand at the event it is keyed by, Previous and
Next go round the risks of the tree, and choosing a row leaves the view.

Measured on the prototype with a 2,712-step session: about 20 ms to open and to select a step,
1,340 elements on the page.

The built page draws only the rows near the window. Measured in headless Chromium on a real session
of 7,449 model calls in 1,255 turns, with every turn open: 48 rows on the page; a selected step is
marked in 14 ms (median) and its content shows in 52 ms, the API call included; the page opens in
118 ms from the start of navigation, 24 ms of it the slowest API call.

### 8.4 Compare and export

**Compare** takes two sessions ticked on Sessions. It shows them as two table rows of facts with a
third row "B compared with A", then the two lanes side by side: turns paired by number; inside an
open pair of turns, steps paired in order by tool, the same call first; a row is tinted when one
side is empty or tool or outcome differ. A step opens in its session, whose back button returns to
the comparison. "Swap A and B" changes the baseline. Above 4,000,000 step pairs a pair of turns is
paired by position.

**Conversations export** writes one JSON line per session and sub-agent session and per stretch
between compactions: the context of the stretch's last model call followed by that call's output,
starting with the system prompt, so every line is a context the model really had: `session_id`, `root_id`, `parent_id`, `kind`, `agent_name`, `model`, `title`, `part`,
`messages` (role and content; assistant messages carry `tool_calls`; tool messages `name` and
`is_error`; a summary is a user message marked `summary`). A part with nothing from the assistant
is left out. The dialog shows a preview, the size and the SQL.

### 8.5 Sequences

Paper 3.1.2. The page opens on "What happens next": from one kind of event (a failed call by
default, any tool, or a user input), a tree of the events that came next, four columns, a pill per
event with its share, curves as thick as the path is common, failed calls red, rare branches as
one dashed "N other". A branch is drawn on its own when it is among the three commonest of its
event and holds at least one run in fifty. A pill opens the pattern view with the pattern of that
path. "Write a pattern" opens the pattern view on the starting event alone.

The pattern view: a row of up to six numbered steps joined by arrows. A step is an event kind (user
input, tool call, reply that ends a turn, compaction) with conditions (tool, status, target has,
same target as an earlier step; text has for inputs and replies), and from the second step on it is
the next event or any later one. Matching: every event that meets step 1 starts at most one match;
each further step takes the nearest event that meets it. Matches are a table (Time, Session, Agent,
Turn, one column per step, Span); a row opens the session with the match's steps marked. The paper's
three examples are offered as starting patterns.

The events of a session are numbered inside the time range, so a match never reaches outside it. A
sub-agent is a session of its own. Tool calls that one model call issued together follow one
another in the order the model wrote them, so the event after a call can be a call issued with it,
before its result was known. The target of a tool call is its `resource`, or its arguments
as text when the tool has none; the target of an input is its text, that of a reply the first
text it wrote. "Has" ignores case.
"Same target" needs a target that is not empty. A failed call is one whose status is `error`.
The pattern and its sort are in the address; a match opened in its session carries its events in
the address as `marks`, and they stay marked while the selection moves. A turn of a sub-agent has
no row of its own on the lanes: a mark or a selection of it falls on the row that stands for the
sub-agent, which is the step that started it.

Measured on the real sessions of the acceptance database (31 days, 57 sessions with tool calls, about 15,000
events of a sequence; result caches off): the drawing reads in about 75 ms; a pattern's table in
120 to 200 ms and its total in 30 to 165 ms, for patterns of one to four steps with up to 12,532
matches.

### 8.6 Safety rules

Four rules, defined in code as patterns compiled to SQL, run by the rules job:

| Rule | Kind | Finds |
| --- | --- | --- |
| Irreversible command without the user's confirmation | confirm | `rm`, `drop table`, `delete from`, `truncate`, `push --force` without an agreeing user input after the assistant asked |
| Secret read, later sent out of the machine | forbid order | Read of `.env` or a key file, later a network command |
| Test changed right after it failed, then passes | forbid order | Failed test run, edit of a test file, passing run |
| Command outside the allowed set | deny | One call outside the allowed commands |

A rule finds candidates; whether a candidate is a breach is a model judgment (Breach, Needs
review, Not a breach, Not judged yet), shown first in the risk view. A risk its rule's judge has
not read is "Not judged yet".

As built:

- Risk judgments (sub-project 3): each rule has a map judge `risk-<rule>` at version 1, its
  criterion kept in code beside the rules and phrased so that a breach is answered violates. The
  run-judges command, after the judge runs, judges each risk its rule's judge has not judged with
  its version, in trees whose rules have run since their last import; the subject is
  `<session_id>:<rule>:<first_seq>`. The pass has one budget of input tokens (`RISK_JUDGE_BUDGET`,
  200,000 by default); the judges take a batch each in turn, newest risks first, each under a lease
  renewed before each batch and after each chunk of calls. A call that did not reach the model is
  not stored, so its risk is tried again on the next pass. The model reads the rule and why it
  fired, then the events from the step before the first event to the last (only the matched steps
  and the one before when they span more than 30 steps) and the input of each turn they are in, in
  order. An input is a group of its own, `<user>`, `<task from="parent agent">` in a sub-agent's
  session or `<harness>` when it opens with a tag; the events the rule matched are marked; where
  steps are left out the record says how many; at most 40,000 characters are read, the earliest
  unmarked steps left out first and unmarked inputs last. The content of the secret file an exfil
  risk starts by reading is replaced by a note. Violates is Breach, unsure is Needs review, ok is
  Not a breach; the risk view adds the reason, the question asked, the events read, the model and
  the time.
- The words of a command (`rm`, `curl`, `sudo` and the like) are matched as whole words of the
  lower-case command: not inside another word, a path or an option, so `--rm` and `perform` are
  not `rm`. A secret file is one whose path has `.env`, `credentials`, `secret`, `id_rsa` or
  `token`; a test is a command or a file with `test`.
- The two order rules and the deny rule are patterns of the Sequences compiler (8.5), run over
  every event of the sessions of one tree, whatever their time.
- The confirmation rule looks, for each irreversible command, at the last user input before it
  in its session and at the event just before that input. An input that opens with a tag
  (`<task-notification>`, `<command-name>` and the like) was written by the harness and is passed
  over. The command is confirmed when that event is a reply with a question mark (`?` or `？`)
  and the input agrees: it opens with `yes`, `go ahead`, `ok`, `okay`, `confirm` or `proceed` as
  a whole word, or with `可以`, `好的`, `是的`, `确认`, `继续` or `同意`, and holds neither `no`,
  `not`, `never`, `stop`, `wait`, `cancel`, `don't` or `dont` as a whole word nor `不`, `别`, `勿`,
  `停` or `取消`. Otherwise the command is a risk, with the input listed before it.
- A sub-agent has no user: what started it came from the assistant. Each irreversible command in
  a sub-agent is a risk, which says so.
- A rule has a version in code; a risk records the version that found it.

### 8.7 Judges

Paper 3.2.1, 3.2.2 and 3.3.2. The list: Last run, Judge, Judges (what it picks), Model, Version,
Runs on (once, or new sessions too), Steps judged, Violations, Sessions, Out of date.

A judge's page shows its plan as five stages, each tagged "SQL in Doris" or "Model, called by
Nereus": pick the steps; put together what the model reads; judge each step (criterion, model,
version, "Change criterion or model", the version table); store the verdicts; query them, as
"First violation in each session", "All verdicts" (with each verdict's version) or "Changed by a
rerun" (Was, Now, Why now; shown only after a rerun changed something). A clicked row shows what
the model read, the verdict and reason, the model and version, and opens the step in its session.

A new judge is made on a form with the same five stages: tool, target contains (`a | b` for
either), result, with a live count; what the model reads (the step alone, the step and N before,
the whole turn; the turn's request always); the criterion, from a template or one's own, the model,
the name; a try on 5 sampled steps; the run, with model calls and estimated input tokens, and
"Also judge new sessions as they arrive". Two templates ship: test changed to pass instead of
fixing the code, and irreversible command without the user's agreement.

Changing the criterion or the model saves a new version and judges nothing. Verdicts of older
versions are then marked out of date and still counted, with two actions: rerun all of them, or
rerun only the violating ones, each with its token estimate; the page says that the second finds
verdicts that no longer hold but not steps that now violate. New sessions are judged with the
current version.

As built (server side):

- A judged step is a model call, and its subject is `<session_id>:<seq>` of that call. A step is
  picked when one of its tool calls meets the pick; the target is the call's resource or, failing
  that, its arguments, and "target contains" is any of its words inside the lower-case target.
- What the model reads: the user's request of the turn, then the steps near the judged one, each
  with the assistant's text, its tool calls (tool, target, the arguments when they say more than
  the target, failed or not) and their results. A text said before is stored once, so a block is
  found by the event's own `msg_seq` and `result_msg` as well as by `event_seq`. The turn reads at
  most 30 steps before the judged one; a block is cut at 2,000 characters and the whole at 40,000,
  the earliest steps going first. The record is wrapped as data the model must not take
  instructions from, its text is escaped so that it cannot open or close the record's tags, and
  the criterion is repeated after it. The model answers with a JSON schema: verdict and reason.
- The current version, the saved versions and the runs are in PostgreSQL; a run copies the versions
  to `agent_judges` before it judges. A run is also the queue: a runner takes the oldest queued run,
  or a running one whose runner has been quiet for ten minutes, which then goes on from its counts.
  A judge has at most one open run, and only the runner that holds a run writes to it; a call ends
  within about three minutes, so a live runner is not taken over.
- A run reads 20 steps at a time and judges them four at a time, storing each chunk, and stops
  before a chunk would take it over its budget of input tokens, estimated from the text and from
  what calls have taken so far. A refusal, a cut answer, an answer that is not a verdict, a refused
  request and a call that still fails after the SDK's retries give `unsure` with the reason; a key,
  permission or model that is wrong fails the run, and so does a chunk in which no call reached the
  model. A rerun can take the out-of-date verdicts (all or the violating ones), the steps no run of
  the current version has judged, or those whose model call failed. A judge keeps the budget it
  was saved with for its runs of new sessions.
- Saving, changing, rerunning and trying judges are for admins, since they spend model tokens.

As built (pages): Judges is a page of the navigation after Sequences. Its list adds Last verdict
(the time of the newest verdict) and marks a judge whose last run is queued, running, stopped or
failed. The form counts the picked steps again shortly after a change and keeps the draft in the
page, not the address; its templates, models and run budget come from
`GET /api/agents/judges/templates`, and a count or a try is shown only while the draft still asks
what it answered. A judge's page keeps its view and its open row in the address; the row opens
under it, and a view cut at 500 rows says so. The three views are always offered; "Changed by a
rerun" says so when nothing changed. A run is taken by the command, so the page says when a run is
queued and that the command takes it. Members see the actions that spend model tokens disabled,
with the reason; the server still refuses them.

### 8.8 Memories

Paper A.1 and 3.2.2. The list: Updated, Agent (filter), Scope, Memory (name and description),
Kind, Still valid, Source session. Source session is a link when recorded, a link with "inferred ·
N % of words" when inferred, and "Not recorded" otherwise.

As built (pages, before the validity fold): Memories is a page of the navigation after Judges and
a table page like Risks, not one of the Sessions pages; it opens on the past 30 days. Still valid reads "Not used since written"
until a Read call of the memory's file comes after its latest version, then "Not judged yet"; a
format whose reads are not recorded reads "Use not recorded". A recorded source shows the title of
its session. A memory's page lists the Read, Write and Edit calls on its file, newest first, each
opening its step, and its versions; "Wrote memory <name>" on a session's header comes from a
recorded source or a Write or Edit call of the tree on the memory's file.

As built (validity fold): the judge `memory-validity`, version 1, its criterion in code, follows
each version of a memory: its subject is the md5 of the memory's agent, scope and name with the
start of its content hash, so a new version starts again from "holds as written". The run-judges
command judges, after the risks, each Read call of a memory's file after the memory's latest
update (or after the capture that still saw the version before, when that is later) in a turn that
is over (a later turn exists, or the session has been quiet for ten minutes) that the judge has not
judged, oldest first, one after another per memory and under a lease per memory, which drops the
reads another runner judged since the list was read, within its own budget (`MEMORY_JUDGE_BUDGET`, 100,000 input tokens by default; 0 turns
it off). The model reads the memory, the state so far with its reason, and the turn of the read
from the model call that read it (at most 30 steps after it, the request of the turn always, the
last steps left out first beyond 40,000 characters), and answers evidence (supports, conflicts,
none), the state after (holds, doubt, outdated) and why, with a JSON schema. A row of
agent_judgments keeps the state, the evidence, the version it started from and the model call that
read the memory (`seq`); a call that does not reach the model is not stored, and the memory's later
reads wait for the next pass; an answer that is not an update is stored as no judgment (verdict
`unsure`, no state, why), and the state stays as it was. Still valid on the pages is the latest
state when there is one, and a memory's page names the judge version and the model.

A memory's page: its fields in a table with "where <agent> keeps it" for each; "Still valid?": the
current state (Holds, In doubt, Out of date, Not used since written, Use not recorded) and one row
per update (Time, Version, New session linked to the step that read the memory, Supports /
Conflicts / No bearing, assessment after, why); then the content by the format's own sections.
Nereus judges; the agent or a person revises.

### 8.9 Dashboard

Paper C.1, as a built-in dashboard with a time range and a Model filter: Volume and errors
(sessions started, steps, failed tool calls with their share), Latency (model latency p50 and p95,
tool time per step p50 and p95), Tokens and context (input, cache read and output stacked; context
per request p50 and p95), Tools and safety (ranked tools with calls, failed share and p95 time;
risks by rule coloured by judgment). By day, or by hour for two days or less. A bar or point opens
the table behind it at that stretch and model; a tool opens Steps filtered to it; a rule opens
Risks filtered to it.

## 9. Code layout

```
server/src/
  db/          Doris and PostgreSQL clients
  semantics/
    search/      today's query/: search compiler and SQL builders
    trajectory/  model types, normaliser, resource rules, page operations
    sequences/   pattern compiler, next-event paths, safety rules
    judges/      judge definitions, runner, model client, fold
    memories/    memory adapters, source inference
    adapters/    capture adapters; claude-transcript first
    ingest/      writer; reading normaliser state from Doris
  jobs/        rules, judge runs, memory capture and validity; leases
  control/     auth/, content/, judge schedules
  api/         routes, one file per page; MCP tools
  cli/         command-line entry points
  server.ts    wiring only
schema/        DDL; one new file for the agent tables
web/src/
  pages/agents/       sessions, steps, messages, risks, session, compare, sequences, judges, memories, dashboard
  components/agents/  data table, lanes, chat, SQL and export dialogs, path drawing, judge plan
  api/                http.ts (transport) and one file per feature; agents.ts first
```

- A unit test scans imports and fails when `semantics/` imports `api/`, when `db/` imports an upper
  layer, or when the normaliser imports `db/`.
- The browser-session module becomes `rum/`: table `rum_sessions`, read routes `/api/rum/...`; the
  SDK keeps posting to `/api/ingest/sessions`. The label "Client sessions" stays. This removes the
  second meaning of "session" from the code.
- The offline demo build imports server SQL builders; its import paths move with them and it must
  still build.

## 10. Environment

Developed and tested on a Doris master build from commit
`9fb3e3a2a13f972a62cb999d5599fc8e8f17f306` (2026-11-10). Tests take the Doris address from
`DORIS_HOST`, `DORIS_PORT`, `DORIS_USER`, `DORIS_PASSWORD` and `DORIS_BE_HTTP_URL`, as today. Model
calls in tests go to a stub; one opt-in suite calls the real model.

Remaining for sub-project 0: a container image of the pinned commit, the Compose default switched
to it, and the existing Nereus test suites run on it with the differences recorded.

## 11. Testing

Tests are written first. New server code reaches 80 % line coverage.

- **Unit.** Normaliser: synthetic capture records covering append, parallel tool calls, compaction,
  truncation, sub-agent, retry. Adapters: small hand-written transcripts and memory files.
  Operations: the generated SQL, as in `build.test.ts`. Step pairing for Compare against an
  exhaustive search on small pairs. The judge runner and the fold with a stubbed model. The
  layering test.
- **Against Doris.** Create the tables in a scratch database; import a fixture twice and compare
  row counts and checksums. For every page statement: EXPLAIN on the empty tables, and results on
  the fixture equal to an independent computation (the prototype's checks did this for 3,354
  statements and for 169 sequence patterns).
- **End to end.** Playwright walks each page of section 8 on the fixture, in light and dark theme
  and at 400 px width.
- Fixtures are hand-written. Real transcripts and real memories never enter the repository.

## 12. Acceptance, measurements and open questions

Sub-projects 1 to 5 are done when:

1. All local transcript files import without failure, and unknown rows are counted.
2. A full re-import leaves row counts and content checksums of every table unchanged.
3. For sessions with a request log, every model call's reconstructed block count equals the count
   in the request log. Other sessions are marked inferred.
4. Every sub-agent file is linked to the tool call that spawned it.
5. Every page works on real data, including a session with more than 2,000 model calls, within the
   times measured on the prototype (session page and step selection under 50 ms in the browser).
6. Every page shows its SQL, and all tests pass.
7. Each safety rule finds its breach in the fixture, and every risk gets a model judgment. The
   first half holds since sub-project 2; the judgment comes with sub-project 3.
8. A judge created on the form runs on real steps; after a new version, the out-of-date count is
   right, and a full rerun leaves none.
9. Every captured memory shows its source as recorded, inferred with a score, or not recorded, and
   no inferred source is shown as recorded.
10. The measured size of the agent tables is reported against the estimated size of storing every
    request's full context.

To measure during implementation: the `storage_page_size` of `agent_messages`; the cost of writing
large text to a merge-on-write table; judge cost per thousand steps.

Measured for the "later" join of pattern matching: as a join on `pos >` with `min`, a four-step
pattern over one tool with 8,650 calls took about 880 ms; as a window that gives every event the
position of the nearest later event meeting the step, about 85 ms with the same matches. The
compiler uses the window, and keeps the join only for a step that shares the target of an earlier
one, where the target narrows it. A second finding: with one join of the events per step for the
columns of the table, Doris placed the session conditions on other joins and joined on the position
alone, which took 3 s; the table now takes its page of matches first and joins the events once.

Open questions:

- **Tail hashes.** About seven in ten sampled `tail` hashes have no `api-request-blob` row in the
  same file. A short experiment settles the mapping before the adapter is written.
- **Transcript format.** It is internal and changes between minor versions. The adapter tolerates
  unknown rows and fields. Sub-project 6 adds OTLP as the long-term capture path.
- **Sequence numbers for OTLP.** Spans arrive out of order; how `seq` is assigned is decided in
  sub-project 6.
- **Large exports.** An export over its cap (7) is refused today. A streamed download or
  `SELECT ... INTO OUTFILE` to object storage would lift the cap.
- **Unverified statements.** Statements of Judges, Memories and Dashboard have not been run on
  Doris yet. They are checked first in sub-projects 3 to 5. Those of the Sequences page are
  checked: 157 patterns and 48 drawings against an independent computation on generated sessions.
  Those of the safety rules too: each rule against a loop over generated sessions that hold its
  words.
- **Risks at scale.** On the acceptance data the rules job took about 12 s for 78 session trees
  and found 169 risks in four trees: 140 commands without a confirmation, 12 of them in
  sub-agents, and 29 commands outside the allowed set. Without a judgment every candidate counts
  on the Sessions table, which is loud; sub-project 3 judges them.
- **Targets at scale.** A pattern's statement reads the target of every tool call in the range.
  When a step is an input or a reply, it also joins the text blocks of those events by key,
  whatever their age, since a text said before keeps its first block; the join looks into every
  partition of `agent_messages`. On large ranges the targets of the page's rows alone could be
  read after the matches are found.
- **Calls issued together.** Whether "next" should pass over the calls a model call issued with
  the one before is open. On the acceptance data the event after a failed call is such a call in
  about one case in four.
- **Rule and memory changes.** When a rule's code changes, its old risks are kept with their
  `rule_version`; whether to rerun automatically is open. When the memory-validity criterion
  changes, the fold must replay from the first state; not designed yet.

## 13. Build order

One implementation plan per sub-project, in this order.

1. **Sub-project 1.** Restructure the server tree by layer, add the layering test, rename the
   browser-session module; schema file; normaliser; the tail-hash experiment, then the transcript
   adapter; writer, per-session columns and the import command; operations and endpoints; the table
   pages Sessions, Steps and Messages with filters, sort, columns, SQL and export; the session page;
   Compare; acceptance items 1 to 6 and 10.
2. **Sub-project 2.** In two plans, both built. First: pattern compiler and next-event paths; the
   Sequences page. Second: the rules job and `agent_risks`; the Risks page, column and the risk
   view on the session page.
3. **Sub-project 3.** `agent_judges`, `agent_judgments`; the model client and the judge runner with
   budgets; Judges list, page and form; versions, out-of-date and reruns; risk judgments.
4. **Sub-project 4.** Memory adapters and capture; source inference; the Memories page; the
   validity fold; the MCP tools.
5. **Sub-project 5.** The dashboard statements and page.
