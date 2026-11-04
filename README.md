# Graph database benchmark

Compares graph databases under the same load, on the same data, with the same resource limits.
It currently compares **Neo4j** (2026.07.1 Community + GDS) and **Memgraph** (MAGE 3.14.0), and can be
extended to other engines (see [Adding a database](#adding-a-database)).

It covers:

- **Stress:** ramps concurrency until each engine saturates, runs heavy queries, applies a load spike and measures recovery.
- **Soak:** holds a steady open-loop load for hours and flags latency drift, memory growth and errors.
- **Strengths of each engine:** point reads and native algorithms (Memgraph), larger-than-memory data and
  analytical aggregates (Neo4j), cold start and capacity.

The data is a small fraud-detection graph (`dataset.cypher`), plus a deterministic generator that scales it up.

## Setup

Requirements: Docker (Compose v2), Node.js >= 24 (runs TypeScript directly) and pnpm.

```sh
cp .env.example .env        # then set real passwords (Neo4j needs >= 8 characters)
pnpm install
docker compose up -d --wait neo4j memgraph
pnpm check                  # typecheck + lint + tests; no database needed
```

`docker compose up` with no service names also runs the one-shot loaders, which load `dataset.cypher`
into both databases. The benchmark does its own loading, so you don't need them.

For Memgraph at large data sizes, raise the Docker VM's `vm.max_map_count`. Memgraph warns about it at
startup and can crash without it. The setting resets when Docker restarts:

```sh
docker run --rm --privileged alpine sysctl -w vm.max_map_count=524288
```

## Running

Run **one database at a time** so they don't compete for the host:

```sh
docker compose stop memgraph && docker compose up -d --wait neo4j
pnpm bench <phase> --db neo4j --tier M
```

| Phase       | What it does                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `load`      | Clears the database, creates indexes and constraints, loads the tier. Every other phase loads first unless `BENCH_SKIP_LOAD=1`.                  |
| `validate`  | Runs every query with fixed parameters and compares checksums, counts and algorithm results with the other engines' runs. Exits 1 on a mismatch. |
| `baseline`  | One client, each query in turn: raw latency.                                                                                                     |
| `stress`    | Concurrency ramp per mix (read-heavy, write-heavy, ingest, soak mix), then heavy queries, then a spike. Writes `results/knee-<db>-<tier>.json`.  |
| `soak`      | Fixed open-loop rate (default 0.6 × the lowest soak-mix knee across engines) for `BENCH_SOAK_MINUTES` (default 240).                             |
| `algo`      | PageRank, WCC and Louvain through each engine's native library (MAGE / GDS).                                                                     |
| `capacity`  | In-memory engines ingest until their memory limit; disk-based engines continue to `BENCH_CAPACITY_X` × that.                                     |
| `coldstart` | Restarts the container: time until ready, then latency of the first queries.                                                                     |

Tiers: **S** is `dataset.cypher` as is (510 nodes), **M** is about 100k nodes, **L** is about 2M nodes. Use the same tier for
every engine.

Recommended order per tier: `validate` on all engines → `baseline` → `stress` → `algo` → `capacity`
(in-memory engines first) → `coldstart` → `soak`. The soak rate comes from the stress results, so
`stress` must have run on every engine first.

A quick end-to-end check takes a few minutes:

```sh
BENCH_STRESS_STEP_SEC=5 BENCH_WARMUP_SEC=2 BENCH_REPEATS=1 BENCH_CONCURRENCY=1,8 pnpm bench stress --db neo4j --tier S
BENCH_SOAK_MINUTES=3 BENCH_SOAK_RATE=50 pnpm bench soak --db neo4j --tier S
```

### Configuration

Every tunable number is a `BENCH_*` environment variable, with its default and a description in
`.env.example`. Set them in `.env` or inline for a single run; inline values win.

Two settings are also read by Docker Compose and only apply after you recreate the container
(`docker compose up -d memgraph`):

- `BENCH_QUERY_TIMEOUT_SEC`: Memgraph's server-side query timeout.
- `MG_WAL_FLUSH_EVERY_N_TX=1`: Memgraph fsyncs on every commit, like Neo4j does by default. Run the
  write-heavy steps both ways to compare at equal durability.

### Fairness rules built in

- **Same limits:** 2 CPUs and 4 GB per container. Neo4j gets a 2 GB heap and 1 GB page cache. Memgraph gets a 3.6 GB memory limit.
- **Same client:** the same Bolt driver, pool size, seeded parameters and query text, except where the dialects differ
  (`overrides` in `bench/engines/*.ts`).
- **Same retry policy:** transient conflicts and deadlocks are retried with jittered backoff, timeouts never. Every retry is counted.
- **Clean steps:** writes made during a step are deleted afterwards, so each step starts from the loaded data.
- **No coordinated omission:** the open loop (soak, spike) measures latency from each request's scheduled send time.

Docker Desktop on macOS, with the client on the same host, is noisy. Use the numbers for relative comparison. Use
a Linux host for numbers you publish.

## How it works

### The data

The graph models payments for fraud detection:

```
(:Customer {id, name, country}) -[:OWNS]-> (:Account {id, type, opened})
(:Customer) -[:USES]-> (:Device {id, os})
(:Account) -[:SENT]-> (:Transaction {id, amount, date}) -[:RECEIVED_BY]-> (:Account | :Merchant {id, name, category, country})
```

**Tier S** is `dataset.cypher` as is: 510 nodes and 723 relationships. It is too small to measure storage or
traversal costs (everything fits in a CPU cache), so it is used for correctness and as a latency floor.

**Tiers M and L** come from a seeded generator (`bench/gen.ts`). It keeps the dataset's ID formats, value ranges and
label ratios, and adds what a realistic benchmark needs:

- **Volume:** at scale `s` there are 71·s customers, 81·s accounts, 62·s devices, 283·s transactions and 13·√s
  merchants. Merchants grow more slowly, so they become hubs. M is s = 200 and L is s = 4000 (`BENCH_SCALE_M`, `BENCH_SCALE_L`).
- **Skew:** senders and receivers are drawn from a power-law distribution, so a few accounts and merchants have
  thousands of transactions. Half of the transactions go to an account and half to a merchant, as in the dataset.
- **Realistic values:** amounts are log-normal (median about 250, between 6 and 13,150), dates span the year up to
  2026-10-11, and every customer owns at least one account.
- **Known fraud patterns:** about 1% of customers form device-sharing rings of 3 to 8 people (ring devices are
  `DEV-R<n>`), and 0.2% of accounts form money cycles of 3 to 5 hops. They come from their own random number
  generator, so `validate` can recompute where they are and check that every engine finds them.

The same `BENCH_SEED` produces identical data for every engine. Loading clears the database (relationships first,
then nodes, 10,000 per transaction, so hub nodes never create a huge transaction), creates a unique `id` per label
and an index on `Transaction.date`, then inserts with `UNWIND` batches of `BENCH_BATCH_SIZE` rows. For in-memory
engines, loading tier M also records memory per scale unit, so a tier L that won't fit is refused before loading.

### Workloads

Parameters are drawn from a seeded random number generator per client. Every query runs as one transaction with
the query timeout.

| ID    | Query                                                                                       | Exercises                                   |
| ----- | ------------------------------------------------------------------------------------------- | ------------------------------------------- |
| R1    | Customer by id                                                                              | point lookup; in-memory engines             |
| R2    | A customer's accounts and devices                                                           | 1-hop expansion                             |
| R3    | An account's last 20 transactions                                                           | expansion + sort                            |
| R4    | Money flow: account → tx → account → tx, first 100                                          | 4-hop traversal                             |
| R5    | Other customers sharing a device with a customer                                            | ring detection                              |
| R6    | Volume per merchant category over a 30-day window                                           | range-index scan + aggregation; planner     |
| R7    | Top 10 merchants by total volume                                                            | full scan + aggregation; larger-than-memory |
| R8    | Shortest path between two customers, up to 8 hops (GQL `SHORTEST`; Memgraph `*BFS`)         | path finding                                |
| R9    | Number of cycles from an account back to itself in 3 to 5 hops                              | variable-length expansion                   |
| W1    | Create a transaction between two accounts                                                   | small write transaction                     |
| W2    | Create 1,000 transactions with one `UNWIND`                                                 | batch ingest                                |
| W3    | Update an account's type                                                                    | update; write conflicts                     |
| W4    | Delete a transaction W1 created (100 behind, so it never races the create)                  | delete                                      |
| A1–A3 | PageRank, weakly connected components, Louvain on the Account → Transaction → Account graph | native algorithm libraries (MAGE vs GDS)    |

Transactions created by W1 and W2 get a `TXN-` id prefix and are deleted after each measured step, so every step
starts from the loaded data.

Mixes combine workloads by weight (percent):

| Mix           | Reads (R1–R5, equal shares) | W1  | W3  | Other                                                     |
| ------------- | --------------------------- | --- | --- | --------------------------------------------------------- |
| `read-heavy`  | 90                          | 5   | 5   |                                                           |
| `write-heavy` | 30                          | 35  | 35  |                                                           |
| `ingest`      |                             |     |     | W2 only                                                   |
| `soak`        | 80                          | 15  | 5   | W4 at W1's rate, so the graph size stays steady for hours |

### Load models

- **Closed loop:** N clients each send their next query as soon as the previous one returns. This finds the most
  throughput an engine delivers at a given concurrency. Used by `stress` (ramps and heavy queries) and `baseline` (N = 1).
- **Open loop:** queries are sent on a fixed schedule whatever the response times. Latency counts from the scheduled
  send time, so a stalled server shows up as latency instead of fewer requests. If more than `BENCH_MAX_IN_FLIGHT`
  are outstanding, the client sheds requests and counts them as errors. Used by the spike and `soak`.

Failed queries are retried only for transient errors (write conflicts, deadlocks), up to `BENCH_MAX_RETRIES` times
with jittered exponential backoff, and never for timeouts. The reported latency includes the retries and the wait
for a pooled connection.

### What each phase measures

Each measured step has three parts: a warm-up of `BENCH_WARMUP_SEC` (discarded), the measurement, then cleanup of `TXN-` writes.

- **`validate`:** runs each read query with the same 20 parameter sets on every engine. Rows are put in a canonical
  form (keys sorted, numbers rounded to 9 significant digits to absorb differences in floating-point summation
  order, rows sorted) and hashed. Hashes, node counts and relationship counts must match. The injected ring and
  cycle must be found. The PageRank top 10 must overlap in at least 8 entries, and the WCC component counts must
  match. Louvain is a heuristic, so its community count is only reported.
- **`baseline`:** one client, each query on its own: `BENCH_BASELINE_ITERS` iterations after the warm-up.
- **`stress`:**
  1. **Ramp:** for each mix, every concurrency in `BENCH_CONCURRENCY` runs `BENCH_REPEATS` times for
     `BENCH_STRESS_STEP_SEC` each, and the median repeat (by throughput) is kept. The ramp stops early when errors
     exceed `BENCH_STOP_ERROR_PCT` or p99 exceeds `BENCH_STOP_P99_MS`. The **knee** is the highest median
     throughput; it is saved for `soak` and the spike.
  2. **Heavy queries:** R4, R7, R8 and R9 alone at each `BENCH_HEAVY_CONCURRENCY`.
  3. **Spike:** read-heavy open loop at low × knee for one step, high × knee for the spike length, then low again for
     two steps (`BENCH_SPIKE`). **Recovery** is the time from the end of the spike until a window's p99 is within 20% of
     the median p99 before the spike. Its resolution is one window.
- **`soak`:** open loop at `BENCH_SOAK_RATE` × the lowest soak-mix knee across `BENCH_ENGINES`, so every engine gets
  the same offered load, for `BENCH_SOAK_MINUTES`. At the end it computes three things:
  - **p99 drift:** the median window p99 of the last hour against the first hour (thirds for runs shorter than 3
    hours). It is flagged above `BENCH_DRIFT_PCT`.
  - **Memory slope:** a linear fit of container memory in MiB per hour, ignoring the first `BENCH_MEM_SETTLE_MIN`
    minutes. If it stays positive, look for a leak.
  - **Total errors.**

  Periodic engine work, such as Memgraph snapshots and Neo4j checkpoints, stays at the defaults. It is part of
  what a soak should show.
- **`algo`:** each algorithm `BENCH_REPEATS` times. Memgraph runs MAGE on the live graph in one query (after an
  untimed `FREE MEMORY`). Neo4j needs a GDS projection first: `project`, `run` and `total` are recorded separately,
  and the projection is dropped afterwards.
- **`capacity`:** inserts W2-style rows in batches of `BENCH_BATCH_SIZE`. Every million nodes it probes R1 and R6
  latency (50 runs each) and container memory. An in-memory engine stops at its memory-limit error and records its
  maximum node count. A disk-based engine goes to `BENCH_CAPACITY_X` × that maximum. The inserted data is then
  removed, so the database isn't left at its limit.
- **`coldstart`:** `docker compose stop` and `start`, then the time to the first successful query. After that,
  `BENCH_BASELINE_ITERS` reads compare the p50 of the first 10% with the last 10%. This shows snapshot loading on
  in-memory engines and cold caches on disk-based ones.

### Metrics

- **Latency:** milliseconds measured by the client, per query.
- **Percentiles:** exact, by sorting every window and step (nearest rank), so no histogram approximation.
- **Throughput:** successful queries per second.
- **Errors:** queries that failed after retries. Retries are counted separately.
- **Container metrics:** every window (`BENCH_SAMPLE_SEC`) the runner records CPU from `docker stats` (100% = one core,
  so the cap is 200%), container memory, the size of the data directory, and the engine's own memory accounting
  where it has one (Memgraph).

## Output

Each run writes `results/<db>-<phase>-<tier>-<UTC time>.*`:

- **`.csv`:** the metrics. The header lines (`#`) hold the effective config, the git commit and the server settings.
  Row kinds:
  - `window`: every `BENCH_SAMPLE_SEC`, per query and `ALL`, with container CPU, memory and store size.
  - `step`: one measured step.
  - `median`: the median of a step's repeats.
  - `load`, `algo`, `spike`, `flags`, `capacity`, `coldstart`: phase-specific results.
- **`.log`:** the run log (see below).
- **`.container.log`:** the database's last 300 log lines. Written only when the run fails or the container stops.

Shared state between runs: `knee-*.json` (stress → soak), `validate-*.json` (cross-engine comparison),
`capacity-*.json` (in-memory → disk-based capacity target), `*-mem-per-scale.json` (tier M → tier L memory check).

## When a run fails

Start with the last line of the run's `.log`:

```
RUN FINISHED status=ok|failed|interrupted phase=... db=... tier=... duration=...s csv=...
```

- **The line is missing:** the Node process itself was killed, for example by an OOM kill of the client or a closed
  terminal. The last `TRACE` heartbeat shows when, and the `[step label]` shows where.
- **`status=failed`:** read upwards from the end for:
  - `FATAL in "<step>"`: the exception that ended the run, with codes and a stack trace.
  - `container <db> stopped|restarted`: the database died. The line includes `oomKilled`, the exit code and a hint
    (137 = SIGKILL or OOM, 133 = SIGTRAP, …). The database's own last lines are in `.container.log`.
  - `query error <query>: ...`: the first occurrence of each distinct query error, with the step, the parameters and
    the full driver error (`code`, `gqlStatus`, retriable). Repeats are counted every 1000 occurrences, and the
    end of the log has a summary of errors by query.
  - `sampling: ... failed`: problems with `docker stats`, `du` or the engine's memory query. The run continues.
- **`status=interrupted`:** SIGINT or SIGTERM.

`TRACE` lines are a heartbeat every window (`[step] t= ops/s= p99= errors= cpu= mem=`) and step markers. They
appear only in the file. `grep -v TRACE` gives the console view.

Common causes:

| Symptom                                          | Likely cause                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `Memory limit exceeded` (Memgraph)               | Data plus query memory is above 3.6 GB. Lower `BENCH_SCALE_L`, or expected during `capacity`.                     |
| `MemoryPoolOutOfMemoryError` (Neo4j)             | A single transaction is too big for `dbms.memory.transaction.total.max`. Lower `BENCH_BATCH_SIZE`.                |
| Memgraph exits with 133                          | `vm.max_map_count` too low (see Setup).                                                                           |
| `tier L would use ~N MiB ... Set BENCH_SCALE_L=` | The tier M memory measurement predicts tier L won't fit. Use the suggested scale for every engine.                |
| `client: too many requests in flight`            | The open loop is far above what the engine sustains, so the client sheds load (`BENCH_MAX_IN_FLIGHT`).            |
| Soak refuses to start                            | `knee-*.json` is missing for an engine in `BENCH_ENGINES`. Run `stress` first, or set `BENCH_SOAK_RATE` to ops/s. |

## Code layout

```
bench/
  run.ts          phases, load generators (closed and open loop), metrics, CSV, failure handling
  queries.ts      workloads R1–R9 (reads), W1–W4 (writes), mixes; portable Cypher
  gen.ts          deterministic data generator + loader
  config.ts       every BENCH_* setting
  log.ts          run log
  engines/
    engine.ts     the Engine interface + shared Bolt client
    neo4j.ts      DDL, GDS algorithms, server info
    memgraph.ts   DDL, dialect overrides, MAGE algorithms, memory accounting
    index.ts      registry
  gen.test.ts     generator self-checks
```

Development: `pnpm check` runs typecheck, lint and tests, `pnpm format` applies the formatter and safe lint fixes
(Biome), and `pnpm typecheck` runs the type check on its own.

## Adding a database

Everything engine-specific is behind `Engine` in `bench/engines/engine.ts`. To add one (FalkorDB, for example):

1. **`bench/engines/<name>.ts`:** implement `Engine`.
   - `run()` returns plain row objects. A Bolt engine can reuse `bolt()`. Others, such as FalkorDB over the Redis
     protocol with its own client, implement `run()` with that client and map results to `{column: value}` rows.
   - `run()` must enforce `timeoutMs`, and `retriable()` must tell write conflicts apart from timeouts.
   - `ddl`: unique `id` per label and an index on `Transaction.date`, in the engine's syntax.
   - `overrides`: replacements for any query in `queries.ts` the engine can't run as written. R8 uses GQL
     `SHORTEST`.
   - `algo()`: the three algorithms with the exact contract documented above `ALGOS` in `engine.ts`, so
     `validate` can compare results.
   - `inMemory`, `memory()` and `settle()`: needed for the capacity phase and the tier L memory check.
   - `serverInfo()`: version and the settings that affect fairness.
2. **`bench/engines/index.ts`:** register it. The key is the `--db` value.
3. **`docker-compose.yml`:** add a service with the same name and the same `cpus` and `mem_limit`.
4. **`.env.example` / `.env`:** add `<NAME>_URI`, `<NAME>_USER` and `<NAME>_PASSWORD`, and add the name to
   `BENCH_ENGINES` if it isn't the default.
5. **Check it:** `pnpm bench validate --db <name> --tier S`, then `--tier M`. Every check against the existing
   engines should be `OK` before you trust any timing.
