// Registered databases. Key = `--db` value = docker compose service name = env prefix.
import type { Engine } from './engine.ts';
import { memgraphEngine } from './memgraph.ts';
import { neo4jEngine } from './neo4j.ts';

export const ENGINES: Record<string, (poolSize: number) => Engine> = {
  neo4j: neo4jEngine,
  memgraph: memgraphEngine,
};
