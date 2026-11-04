// Every tunable number of the benchmark. Override any of them with a BENCH_* env var
// (in .env, or inline: `BENCH_SOAK_MINUTES=5 pnpm bench soak ...`).

function num(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name}=${raw} is not a number`);
  return v;
}

function list(name: string, def: number[], len?: number): number[] {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = raw.split(',').map((s) => Number(s.trim()));
  if (v.some((x) => !Number.isFinite(x)) || (len !== undefined && v.length !== len)) {
    throw new Error(`${name}=${raw} must be ${len ?? 'a list of'} comma-separated numbers`);
  }
  return v;
}

function names(name: string, def: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const [spikeLow, spikeHigh, spikeSec] = list('BENCH_SPIKE', [0.25, 1.5, 60], 3);
const [soakReads, soakCreates, soakUpdates] = list('BENCH_SOAK_MIX', [80, 15, 5], 3);

export const config = {
  // Engines being compared: validate, soak (shared rate) and capacity (shared target) look at all of them.
  engines: names('BENCH_ENGINES', ['neo4j', 'memgraph']),
  seed: num('BENCH_SEED', 42),
  scaleM: num('BENCH_SCALE_M', 200),
  scaleL: num('BENCH_SCALE_L', 4000),
  batchSize: num('BENCH_BATCH_SIZE', 10000),
  memHeadroom: num('BENCH_MEM_HEADROOM', 0.6),
  warmupSec: num('BENCH_WARMUP_SEC', 30),
  baselineIters: num('BENCH_BASELINE_ITERS', 1000),
  repeats: num('BENCH_REPEATS', 3),
  stressStepSec: num('BENCH_STRESS_STEP_SEC', 60),
  concurrency: list('BENCH_CONCURRENCY', [1, 2, 4, 8, 16, 32, 64, 128, 256]),
  heavyConcurrency: list('BENCH_HEAVY_CONCURRENCY', [8, 32]),
  queryTimeoutSec: num('BENCH_QUERY_TIMEOUT_SEC', 60),
  maxRetries: num('BENCH_MAX_RETRIES', 10),
  maxInFlight: num('BENCH_MAX_IN_FLIGHT', 5000),
  stopErrorPct: num('BENCH_STOP_ERROR_PCT', 1),
  stopP99Ms: num('BENCH_STOP_P99_MS', 1000),
  spikeLow,
  spikeHigh,
  spikeSec,
  soakMinutes: num('BENCH_SOAK_MINUTES', 240),
  soakRate: num('BENCH_SOAK_RATE', 0.6),
  soakReads,
  soakCreates,
  soakUpdates,
  sampleSec: num('BENCH_SAMPLE_SEC', 10),
  driftPct: num('BENCH_DRIFT_PCT', 20),
  memSettleMin: num('BENCH_MEM_SETTLE_MIN', 30),
  capacityX: num('BENCH_CAPACITY_X', 2),
};

export type Config = typeof config;

export type Tier = 'S' | 'M' | 'L';

export function connection(engine: string) {
  const p = engine.toUpperCase();
  const get = (k: string) => {
    const v = process.env[`${p}_${k}`];
    if (!v) throw new Error(`${p}_${k} is not set (see .env.example)`);
    return v;
  };
  return { uri: get('URI'), user: get('USER'), password: get('PASSWORD') };
}
