# AstraMemory Local v1 — Wave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship AstraMemory Local v1 (M1-M5 from spec) in ~3-4 weeks using parallel agent waves after a sequential foundation wave.

**Architecture:** Single Node process (Fastify HTTP daemon + in-process worker loop), SQLite as source of truth, sqlite-vec for vectors, two LLM providers (Ollama, Azure OpenAI), 8-stage distillation. Per-OS user-scope service install. Wire-compatible with existing `memory-plugin` via env-swap.

**Tech Stack:** Node 20+ ESM, TypeScript strict, Fastify, better-sqlite3, sqlite-vec, @inquirer/prompts, Zod, vitest, GitHub Actions cross-OS CI.

**Spec:** `docs/superpowers/specs/2026-06-27-astramemory-local-v1-design.md`

---

## Wave map

```
Wave 1 (week 1, SEQUENTIAL, single owner)
  └─ Foundation: schema, sqlite-vec, FTS5, ingest endpoint, serve skeleton, type contracts

Wave 2 (week 2, PARALLEL 4 tracks)
  ├─ Track A: pipeline (job table, worker loop, state machine)
  ├─ Track B: search (hybrid fusion, /search, CLI)
  ├─ Track C: service install + doctor v1
  └─ Track D: providers ×4 (Ollama LLM, Azure LLM, Ollama Embed, Azure Embed)

Wave 3 (week 3, depends on A+D — single owner)
  └─ Distillation: 8 stages, extraction prompt, Zod validation, budget tracker

Wave 4 (week 4, integration)
  ├─ Wizard (depends on C+D)
  ├─ Cross-OS CI matrix
  ├─ E2E test (plugin hook → daemon → distill → search)
  └─ README + migration guide
```

**Critical path:** Wave 1 → Track A → Wave 3 → Wave 4 = ~4 weeks minimum.

**Coordination rules:**
- Interfaces locked at end of Wave 1 in `src/contracts/`. Any change to those files requires PR review.
- Migrations append-only. One file per track, named `NNN-track-X-purpose.sql`.
- Doctor checks added by track owners as their work lands; merged by Track C owner.

**Bootstrap:** Repo `astramemory-local` does not yet exist. Wave 1 Task 1 creates it.

---

## Wave 1 — Foundation (sequential, single owner, ~5 days)

### Task 1: Scaffold new repo

**Files:**
- Create: `astramemory-local/package.json`
- Create: `astramemory-local/tsconfig.json`
- Create: `astramemory-local/.gitignore`
- Create: `astramemory-local/README.md` (stub, one paragraph)

- [ ] **Step 1: Create directory**

Run: `mkdir astramemory-local && cd astramemory-local && git init -b main`

- [ ] **Step 2: Write package.json**

```json
{
  "name": "@astragenie/astramemory-local",
  "version": "0.0.1",
  "type": "module",
  "bin": { "astra-memory": "./dist/cli/index.js" },
  "scripts": {
    "build": "tsc -p .",
    "dev": "tsc -w -p .",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "sqlite-vec": "^0.1.0",
    "fastify": "^4.28.0",
    "zod": "^3.23.0",
    "@inquirer/prompts": "^5.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^20.0.0"
  },
  "license": "MIT"
}
```

- [ ] **Step 3: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Write .gitignore**

```
node_modules/
dist/
*.sqlite*
*.log
.env
secrets.env
.vitest-cache/
```

- [ ] **Step 5: Install deps**

Run: `npm install`
Expected: `node_modules/` populated, no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json .gitignore README.md package-lock.json
git commit -m "chore: scaffold astramemory-local repo"
```

### Task 2: Lock type contracts (the parallelism anchor)

**Files:**
- Create: `src/contracts/llm.ts`
- Create: `src/contracts/embed.ts`
- Create: `src/contracts/vector.ts`
- Create: `src/contracts/memory.ts`
- Create: `src/contracts/job.ts`
- Create: `src/contracts/index.ts`

- [ ] **Step 1: Write LLM contract**

`src/contracts/llm.ts`:
```ts
export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOpts {
  temperature?: number;
  json?: boolean;
  maxTokens?: number;
}

export interface ChatUsage {
  in: number;
  out: number;
  usd: number;
}

export interface ChatResult {
  text: string;
  usage: ChatUsage;
}

export interface LLMHealth {
  ok: boolean;
  model: string;
  latency_ms: number;
  error?: string;
}

export interface LLMProvider {
  readonly name: 'ollama' | 'azure-openai';
  readonly model: string;
  chat(messages: ChatMsg[], opts?: ChatOpts): Promise<ChatResult>;
  health(): Promise<LLMHealth>;
}
```

- [ ] **Step 2: Write embed contract**

`src/contracts/embed.ts`:
```ts
export interface EmbedHealth {
  ok: boolean;
  model: string;
  dim: number;
  error?: string;
}

export interface EmbedProvider {
  readonly name: 'ollama' | 'azure-openai';
  readonly model: string;
  readonly dim: 1024;
  embed(texts: string[]): Promise<Float32Array[]>;
  health(): Promise<EmbedHealth>;
}
```

- [ ] **Step 3: Write vector store contract**

`src/contracts/vector.ts`:
```ts
export interface VecFilter {
  type?: string[];
  repo?: string;
  project?: string;
  since?: number;
}

export interface VecHit {
  id: string;
  score: number;
}

export interface VectorStore {
  readonly name: 'sqlite-vec' | 'lancedb';
  upsert(id: string, vec: Float32Array): Promise<void>;
  search(vec: Float32Array, k: number, filter?: VecFilter): Promise<VecHit[]>;
  rebuild(): Promise<void>;
}
```

- [ ] **Step 4: Write memory + job contracts**

`src/contracts/memory.ts`:
```ts
export type MemoryType = 'decision' | 'fact' | 'lesson' | 'command' | 'todo';

export interface Memory {
  id: string;
  type: MemoryType;
  text: string;
  normalized_text: string;
  repo: string | null;
  project: string | null;
  branch: string | null;
  agent: string | null;
  session_id: string | null;
  importance: number;
  confidence: number;
  hash: string;
  embedding_provider: string | null;
  embedding_model: string | null;
  embedding_dim: number | null;
  created_at: number;
  updated_at: number;
  source_hash: string | null;
}
```

`src/contracts/job.ts`:
```ts
export type JobState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'poison'
  | 'paused';

export type JobKind = 'distill' | 'reembed' | 'cleanup';

export interface Job {
  id: string;
  kind: JobKind;
  payload_json: string;
  state: JobState;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}
```

`src/contracts/index.ts`:
```ts
export * from './llm.js';
export * from './embed.js';
export * from './vector.js';
export * from './memory.js';
export * from './job.js';
```

- [ ] **Step 5: Compile to verify types**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/contracts/
git commit -m "feat(contracts): lock provider + memory + job interfaces

These interfaces are the contract surface that Wave 2 parallel
tracks build against. Changes require PR review."
```

### Task 3: SQLite migration runner + schema v1

**Files:**
- Create: `src/storage/db.ts`
- Create: `src/storage/migrate.ts`
- Create: `migrations/001-init.sql`
- Create: `tests/storage/migrate.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/storage/migrate.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';

describe('migrate', () => {
  it('creates schema_version table and applies 001-init', () => {
    const db = openDb(':memory:');
    migrate(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name: string}[];
    const names = tables.map(t => t.name);
    expect(names).toContain('schema_version');
    expect(names).toContain('sessions');
    expect(names).toContain('messages');
    expect(names).toContain('transcripts');
    expect(names).toContain('memories');
    expect(names).toContain('jobs');
    expect(names).toContain('artifacts');
    expect(names).toContain('provider_state');
    expect(names).toContain('budget_spend');
  });

  it('is idempotent — second run does nothing', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrate(db);
    const versions = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as {n: number};
    expect(versions.n).toBe(1);
  });

  it('enables WAL mode', () => {
    const db = openDb(':memory:');
    migrate(db);
    const mode = db.prepare('PRAGMA journal_mode').get() as {journal_mode: string};
    // :memory: DBs report 'memory', file DBs report 'wal'. Confirm setting attempt didn't error.
    expect(['wal', 'memory']).toContain(mode.journal_mode);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- migrate`
Expected: FAIL with module not found errors.

- [ ] **Step 3: Write db opener**

`src/storage/db.ts`:
```ts
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export type DB = Database.Database;

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  sqliteVec.load(db);
  return db;
}
```

- [ ] **Step 4: Write migration runner**

`src/storage/migrate.ts`:
```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

export function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_version').all() as {version: number}[])
      .map(r => r.version)
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const f of files) {
    const version = parseInt(f.split('-')[0], 10);
    if (Number.isNaN(version)) throw new Error(`bad migration name: ${f}`);
    if (applied.has(version)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, Date.now());
    });
    tx();
  }
}
```

- [ ] **Step 5: Write migration 001-init**

`migrations/001-init.sql`:
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  repo TEXT,
  project TEXT,
  branch TEXT,
  agent TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX idx_sessions_repo_started ON sessions(repo, started_at DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT
);
CREATE INDEX idx_messages_session ON messages(session_id, ts);

CREATE TABLE transcripts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  ingested_at INTEGER NOT NULL
);
CREATE INDEX idx_transcripts_session ON transcripts(session_id);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('decision','fact','lesson','command','todo')),
  text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  repo TEXT,
  project TEXT,
  branch TEXT,
  agent TEXT,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.5,
  hash TEXT NOT NULL,
  embedding_provider TEXT,
  embedding_model TEXT,
  embedding_dim INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source_hash TEXT
);
CREATE UNIQUE INDEX idx_memories_hash ON memories(hash);
CREATE INDEX idx_memories_repo_type ON memories(repo, type, created_at DESC);
CREATE INDEX idx_memories_session ON memories(session_id);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  text, normalized_text, content='memories', content_rowid='rowid'
);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text, normalized_text) VALUES (new.rowid, new.text, new.normalized_text);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, normalized_text) VALUES('delete', old.rowid, old.text, old.normalized_text);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, normalized_text) VALUES('delete', old.rowid, old.text, old.normalized_text);
  INSERT INTO memories_fts(rowid, text, normalized_text) VALUES (new.rowid, new.text, new.normalized_text);
END;

CREATE VIRTUAL TABLE memories_vec USING vec0(embedding FLOAT[1024]);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed','poison','paused')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_jobs_state ON jobs(state, created_at);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE provider_state (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER,
  last_health_ok INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  PRIMARY KEY (provider, model)
);

CREATE TABLE budget_spend (
  day TEXT PRIMARY KEY,
  usd_total REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0
);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- migrate`
Expected: 3 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/storage/ migrations/ tests/storage/
git commit -m "feat(storage): schema v1 + migration runner

Tables: sessions, messages, transcripts, memories (+FTS5 +vec0),
jobs, artifacts, provider_state, budget_spend."
```

### Task 4: Memory repository

**Files:**
- Create: `src/storage/memories.ts`
- Create: `tests/storage/memories.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/storage/memories.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import type { DB } from '../../src/storage/db.js';

describe('MemoryRepo', () => {
  let db: DB;
  let repo: MemoryRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
  });

  it('inserts and reads by id', () => {
    const id = repo.insert({
      type: 'decision',
      text: 'use sqlite-vec for v1',
      normalized_text: 'use sqlite-vec for v1',
      repo: 'astramemory-local',
      hash: 'h1',
      session_id: null,
      project: null,
      branch: null,
      agent: null,
      source_hash: null
    });
    const m = repo.get(id);
    expect(m?.text).toBe('use sqlite-vec for v1');
    expect(m?.type).toBe('decision');
  });

  it('hash dedup — second insert with same hash returns existing id', () => {
    const id1 = repo.insert({
      type: 'fact', text: 't', normalized_text: 't', hash: 'dup',
      repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null
    });
    const id2 = repo.insert({
      type: 'fact', text: 't', normalized_text: 't', hash: 'dup',
      repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null
    });
    expect(id1).toBe(id2);
  });

  it('fts5 search finds inserted memory', () => {
    repo.insert({
      type: 'decision', text: 'use postgres for sync', normalized_text: 'use postgres for sync', hash: 'p1',
      repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null
    });
    const hits = repo.searchFts('postgres', 10);
    expect(hits.length).toBe(1);
    expect(hits[0].text).toContain('postgres');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- memories`
Expected: FAIL — MemoryRepo not found.

- [ ] **Step 3: Implement repository**

`src/storage/memories.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import type { Memory, MemoryType } from '../contracts/index.js';

export interface InsertInput {
  type: MemoryType;
  text: string;
  normalized_text: string;
  repo: string | null;
  project: string | null;
  branch: string | null;
  agent: string | null;
  session_id: string | null;
  hash: string;
  source_hash: string | null;
  importance?: number;
  confidence?: number;
  embedding_provider?: string | null;
  embedding_model?: string | null;
  embedding_dim?: number | null;
}

export interface FtsHit {
  id: string;
  text: string;
  type: MemoryType;
  bm25: number;
}

export class MemoryRepo {
  constructor(private db: DB) {}

  insert(input: InsertInput): string {
    const existing = this.db.prepare('SELECT id FROM memories WHERE hash = ?').get(input.hash) as {id: string} | undefined;
    if (existing) return existing.id;

    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO memories
        (id, type, text, normalized_text, repo, project, branch, agent, session_id,
         importance, confidence, hash, embedding_provider, embedding_model, embedding_dim,
         created_at, updated_at, source_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.type, input.text, input.normalized_text,
      input.repo, input.project, input.branch, input.agent, input.session_id,
      input.importance ?? 0.5, input.confidence ?? 0.5, input.hash,
      input.embedding_provider ?? null, input.embedding_model ?? null, input.embedding_dim ?? null,
      now, now, input.source_hash
    );
    return id;
  }

  get(id: string): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | undefined;
    return row ?? null;
  }

  searchFts(query: string, limit: number): FtsHit[] {
    const rows = this.db.prepare(`
      SELECT m.id, m.text, m.type, bm25(memories_fts) AS bm25
      FROM memories_fts
      JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ?
      ORDER BY bm25 LIMIT ?
    `).all(query, limit) as FtsHit[];
    return rows;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- memories`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/storage/memories.ts tests/storage/memories.test.ts
git commit -m "feat(storage): MemoryRepo — insert with hash dedup + FTS5 query"
```

### Task 5: sqlite-vec adapter

**Files:**
- Create: `src/vector/sqlite-vec.ts`
- Create: `tests/vector/sqlite-vec.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/vector/sqlite-vec.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';

function vec(seed: number): Float32Array {
  const v = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) v[i] = Math.sin(seed + i * 0.01);
  return v;
}

describe('SqliteVecStore', () => {
  it('upserts a vector and returns it via search', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const store = new SqliteVecStore(db);
    await store.upsert('m1', vec(1));
    await store.upsert('m2', vec(100));
    const hits = await store.search(vec(1), 1);
    expect(hits[0].id).toBe('m1');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('orders by similarity', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const store = new SqliteVecStore(db);
    await store.upsert('a', vec(1));
    await store.upsert('b', vec(1.01));
    await store.upsert('c', vec(50));
    const hits = await store.search(vec(1), 3);
    expect(hits[0].id).toBe('a');
    expect(hits[1].id).toBe('b');
    expect(hits[2].id).toBe('c');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- sqlite-vec`
Expected: FAIL — SqliteVecStore not found.

- [ ] **Step 3: Implement adapter**

`src/vector/sqlite-vec.ts`:
```ts
import type { DB } from '../storage/db.js';
import type { VectorStore, VecFilter, VecHit } from '../contracts/index.js';

export class SqliteVecStore implements VectorStore {
  readonly name = 'sqlite-vec' as const;
  constructor(private db: DB) {}

  async upsert(id: string, vec: Float32Array): Promise<void> {
    if (vec.length !== 1024) throw new Error(`expected dim 1024, got ${vec.length}`);
    const rowid = this.rowidFor(id);
    if (rowid !== null) {
      this.db.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(rowid);
    }
    const rowidInsert = this.db.prepare('INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)');
    const targetRowid = rowid ?? this.allocateRowid(id);
    rowidInsert.run(targetRowid, Buffer.from(vec.buffer));
  }

  async search(vec: Float32Array, k: number, _filter?: VecFilter): Promise<VecHit[]> {
    const rows = this.db.prepare(`
      SELECT m.id, distance
      FROM memories_vec
      JOIN memories m ON m.rowid = memories_vec.rowid
      WHERE embedding MATCH ?
      ORDER BY distance LIMIT ?
    `).all(Buffer.from(vec.buffer), k) as {id: string, distance: number}[];
    return rows.map(r => ({ id: r.id, score: 1 / (1 + r.distance) }));
  }

  async rebuild(): Promise<void> {
    this.db.exec('DELETE FROM memories_vec');
  }

  private rowidFor(id: string): number | null {
    const r = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as {rowid: number} | undefined;
    return r?.rowid ?? null;
  }

  private allocateRowid(id: string): number {
    const r = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as {rowid: number} | undefined;
    if (!r) throw new Error(`memory ${id} not in memories table — insert there first`);
    return r.rowid;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Wave 1 owner: this test requires a memory row to exist before vec upsert because rowid is borrowed from memories. Fix the test setup to insert a memories row first.

Update test `beforeEach` block:

```ts
import { MemoryRepo } from '../../src/storage/memories.js';

function makeMemory(repo: MemoryRepo, hash: string): string {
  return repo.insert({
    type: 'fact', text: hash, normalized_text: hash, hash,
    repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null
  });
}
```

Update each test:
```ts
const repo = new MemoryRepo(db);
const id1 = makeMemory(repo, 'm1');
const id2 = makeMemory(repo, 'm2');
await store.upsert(id1, vec(1));
await store.upsert(id2, vec(100));
const hits = await store.search(vec(1), 1);
expect(hits[0].id).toBe(id1);
```

Run: `npm test -- sqlite-vec`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/vector/ tests/vector/
git commit -m "feat(vector): sqlite-vec adapter — upsert + cosine-distance search"
```

### Task 6: Config loader + datadir resolution

**Files:**
- Create: `src/config/datadir.ts`
- Create: `src/config/config.ts`
- Create: `tests/config/config.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/config/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { loadConfig, defaultConfig } from '../../src/config/config.js';

describe('loadConfig', () => {
  it('returns defaults when no file present', () => {
    const cfg = loadConfig(undefined);
    expect(cfg.port).toBe(7777);
    expect(cfg.embedding.provider).toBe('ollama');
    expect(cfg.budget.daily_usd).toBe(10);
  });

  it('overrides defaults from passed object', () => {
    const cfg = loadConfig({ port: 8888 } as any);
    expect(cfg.port).toBe(8888);
    expect(cfg.embedding.provider).toBe('ollama');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- config`
Expected: FAIL.

- [ ] **Step 3: Implement datadir helper**

`src/config/datadir.ts`:
```ts
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export function defaultDataDir(): string {
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'AstraMemory');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'astra-memory');
    default:
      return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'astra-memory');
  }
}

export function defaultConfigDir(): string {
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'AstraMemory');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'astra-memory');
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'astra-memory');
  }
}
```

- [ ] **Step 4: Implement config loader**

`src/config/config.ts`:
```ts
import { defaultDataDir } from './datadir.js';

export interface Config {
  port: number;
  dataDir: string;
  llm: {
    compaction: { provider: 'ollama' | 'azure-openai'; model: string };
    extraction: { provider: 'ollama' | 'azure-openai'; model: string };
  };
  embedding: {
    provider: 'ollama' | 'azure-openai';
    model: string;
    dim: 1024;
  };
  vector: { store: 'sqlite-vec' | 'lancedb' };
  budget: { daily_usd: number };
  ollama: { baseUrl: string };
  azure: { endpoint?: string; deployment?: string; apiVersion: string };
  search: { alpha: number; beta: number; gamma: number; delta: number };
}

export function defaultConfig(): Config {
  return {
    port: 7777,
    dataDir: defaultDataDir(),
    llm: {
      compaction: { provider: 'ollama', model: 'qwen2.5-coder:7b' },
      extraction: { provider: 'ollama', model: 'qwen2.5-coder:7b' }
    },
    embedding: { provider: 'ollama', model: 'nomic-embed-text-v2-moe', dim: 1024 },
    vector: { store: 'sqlite-vec' },
    budget: { daily_usd: 10 },
    ollama: { baseUrl: 'http://127.0.0.1:11434' },
    azure: { apiVersion: '2024-10-21' },
    search: { alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1 }
  };
}

export function loadConfig(overrides: Partial<Config> | undefined): Config {
  const base = defaultConfig();
  if (!overrides) return base;
  return { ...base, ...overrides };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- config`
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/config/ tests/config/
git commit -m "feat(config): default config + per-OS datadir resolution"
```

### Task 7: Fastify server with /health and /ingest/transcript

**Files:**
- Create: `src/server/app.ts`
- Create: `src/server/routes/health.ts`
- Create: `src/server/routes/ingest.ts`
- Create: `tests/server/ingest.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/server/ingest.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';

describe('ingest endpoint', () => {
  it('GET /health returns 200', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('POST /ingest/transcript with valid bearer creates session + transcript + distill job', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      payload: {
        session_id: 's1',
        source: 'PreCompact',
        content: 'user: hi\nassistant: hello',
        repo: 'astramemory-local',
        agent: 'claude-code'
      }
    });
    expect(res.statusCode).toBe(200);
    const sessions = db.prepare('SELECT * FROM sessions WHERE id = ?').all('s1');
    const transcripts = db.prepare('SELECT * FROM transcripts WHERE session_id = ?').all('s1');
    const jobs = db.prepare('SELECT * FROM jobs WHERE state = ?').all('pending');
    expect(sessions.length).toBe(1);
    expect(transcripts.length).toBe(1);
    expect(jobs.length).toBe(1);
  });

  it('POST /ingest/transcript without bearer returns 401', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/transcript',
      payload: { session_id: 's1', source: 'PreCompact', content: 'x' }
    });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ingest`
Expected: FAIL.

- [ ] **Step 3: Implement health route**

`src/server/routes/health.ts`:
```ts
import type { FastifyInstance } from 'fastify';

export async function healthRoute(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true, version: '0.0.1' }));
}
```

- [ ] **Step 4: Implement ingest route**

`src/server/routes/ingest.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../src/storage/db.js';

const IngestSchema = z.object({
  session_id: z.string().min(1),
  source: z.string().min(1),
  content: z.string().min(1),
  repo: z.string().nullable().optional(),
  project: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  agent: z.string().nullable().optional()
});

export function ingestRoute(db: DB) {
  return async (app: FastifyInstance) => {
    app.post('/ingest/transcript', async (req, reply) => {
      const parsed = IngestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
      }
      const { session_id, source, content, repo, project, branch, agent } = parsed.data;
      const now = Date.now();

      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO sessions (id, repo, project, branch, agent, started_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            repo = COALESCE(excluded.repo, repo),
            project = COALESCE(excluded.project, project),
            branch = COALESCE(excluded.branch, branch),
            agent = COALESCE(excluded.agent, agent)
        `).run(session_id, repo ?? null, project ?? null, branch ?? null, agent ?? null, now);

        const transcriptId = randomUUID();
        db.prepare(`
          INSERT INTO transcripts (id, session_id, source, content, ingested_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(transcriptId, session_id, source, content, now);

        const jobId = randomUUID();
        db.prepare(`
          INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at)
          VALUES (?, 'distill', ?, 'pending', 0, ?, ?)
        `).run(jobId, JSON.stringify({ transcript_id: transcriptId, session_id }), now, now);
      });
      tx();

      return { ok: true };
    });
  };
}
```

- [ ] **Step 5: Implement app builder + bearer auth**

Fix the file path in `src/server/routes/ingest.ts` import — should be `'../../storage/db.js'` not `'../../src/storage/db.js'`.

`src/server/app.ts`:
```ts
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../storage/db.js';
import { healthRoute } from './routes/health.js';
import { ingestRoute } from './routes/ingest.js';

export interface AppOpts {
  db: DB;
  token: string;
}

export async function buildApp(opts: AppOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/health') return;
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${opts.token}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  await app.register(healthRoute);
  await app.register(ingestRoute(opts.db));

  return app;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- ingest`
Expected: 3 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/ tests/server/
git commit -m "feat(server): Fastify daemon — /health + /ingest/transcript + Bearer auth

POST /ingest/transcript writes session+transcript+distill job atomically."
```

### Task 8: CLI dispatcher + `astra-memory serve`

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/cli/serve.ts`
- Create: `src/cli/init.ts` (stub for Wave 4)
- Create: `tests/cli/serve.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/cli/serve.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

describe('astra-memory serve', () => {
  it('starts, responds to /health, shuts down on SIGTERM', async () => {
    const proc = spawn(process.execPath, ['dist/cli/index.js', 'serve', '--port', '17777'], {
      env: { ...process.env, ASTRA_MEMORY_DATADIR: ':memory:', ASTRA_MEMORY_TOKEN: 'devtok' },
      stdio: 'pipe'
    });
    await sleep(1500);
    const res = await fetch('http://127.0.0.1:17777/health');
    expect(res.status).toBe(200);
    proc.kill('SIGTERM');
    await new Promise(r => proc.on('exit', r));
  }, 10000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npm test -- serve`
Expected: FAIL.

- [ ] **Step 3: Implement serve command**

`src/cli/serve.ts`:
```ts
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { buildApp } from '../server/app.js';
import { openDb } from '../storage/db.js';
import { migrate } from '../storage/migrate.js';
import { defaultConfig } from '../config/config.js';

export interface ServeOpts {
  port?: number;
  dataDir?: string;
  token?: string;
}

export async function serve(opts: ServeOpts): Promise<void> {
  const cfg = defaultConfig();
  const port = opts.port ?? cfg.port;
  const dataDir = opts.dataDir ?? process.env.ASTRA_MEMORY_DATADIR ?? cfg.dataDir;
  const token = opts.token ?? process.env.ASTRA_MEMORY_TOKEN ?? 'devtok';

  const dbPath = dataDir === ':memory:' ? ':memory:' : join(dataDir, 'memory.sqlite');
  if (dataDir !== ':memory:') mkdirSync(dataDir, { recursive: true });

  const db = openDb(dbPath);
  migrate(db);
  const app = await buildApp({ db, token });

  await app.listen({ port, host: '127.0.0.1' });
  console.log(`astra-memory serving on 127.0.0.1:${port}`);

  const shutdown = async () => {
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
```

- [ ] **Step 4: Implement CLI dispatcher**

`src/cli/index.ts`:
```ts
#!/usr/bin/env node
import { serve } from './serve.js';

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'serve': {
      const port = parseArg(rest, '--port');
      await serve({ port: port ? Number(port) : undefined });
      break;
    }
    case 'init':
      console.log('init wizard lands in M5');
      break;
    case undefined:
    case '--help':
    case '-h':
      console.log(`astra-memory <command>

Commands:
  serve [--port N]     Start daemon (foreground)
  init                 Interactive wizard (M5)

(More commands added in later waves.)`);
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 5: Stub init**

`src/cli/init.ts`:
```ts
// Implemented in Wave 4. See Wave 4 brief.
export async function init(): Promise<void> {
  throw new Error('init wizard not yet implemented — Wave 4');
}
```

- [ ] **Step 6: Build and test**

Run: `npm run build && npm test -- serve`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/ tests/cli/
git commit -m "feat(cli): serve command + dispatcher skeleton

\`astra-memory serve --port N\` boots Fastify daemon on 127.0.0.1."
```

### Task 9: Wire integration test — plugin-style POST end-to-end

**Files:**
- Create: `tests/integration/ingest-e2e.test.ts`

- [ ] **Step 1: Write integration test**

```ts
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

describe('E2E ingest via HTTP', () => {
  it('plugin-shaped POST → session+transcript+job in DB', async () => {
    const proc = spawn(process.execPath, ['dist/cli/index.js', 'serve', '--port', '17778'], {
      env: { ...process.env, ASTRA_MEMORY_DATADIR: ':memory:', ASTRA_MEMORY_TOKEN: 'e2etok' },
      stdio: 'pipe'
    });
    await sleep(1500);

    const body = {
      session_id: 'e2e-1',
      source: 'PreCompact',
      content: 'user: build sqlite-vec adapter\nassistant: ok, file created',
      repo: 'astramemory-local',
      agent: 'claude-code'
    };
    const res = await fetch('http://127.0.0.1:17778/ingest/transcript', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer e2etok' },
      body: JSON.stringify(body)
    });
    expect(res.status).toBe(200);

    proc.kill('SIGTERM');
    await new Promise(r => proc.on('exit', r));
  }, 15000);
});
```

- [ ] **Step 2: Build and run**

Run: `npm run build && npm test -- ingest-e2e`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/
git commit -m "test(integration): E2E ingest — plugin-shaped POST landing in DB"
```

### Task 10: Wave 1 closeout — README + interface freeze tag

**Files:**
- Modify: `astramemory-local/README.md`
- Create: `docs/contracts.md`

- [ ] **Step 1: Write README skeleton**

Replace `README.md`:
```markdown
# AstraMemory Local

Local-first memory daemon for AI coding agents. Wire-compatible with `memory-plugin`.

**Status: Wave 1 (foundation) shipped. Wave 2-4 in progress.**

## What works today

- SQLite + FTS5 + sqlite-vec schema (`memory.sqlite` in user-scope data dir)
- HTTP daemon on 127.0.0.1
- `POST /ingest/transcript` — wire-compat with `memory-plugin` hooks
- `GET /health`
- Bearer auth

## Coming next

- Wave 2: distillation pipeline + providers + search + service install
- Wave 3: 8-stage memory distillation
- Wave 4: install wizard, cross-OS CI, E2E

## Run (dev)

\`\`\`bash
npm install && npm run build
ASTRA_MEMORY_TOKEN=devtok astra-memory serve --port 7777
\`\`\`

## Spec

See `../astramemory-plugin/docs/superpowers/specs/2026-06-27-astramemory-local-v1-design.md`.
```

- [ ] **Step 2: Write contracts doc**

`docs/contracts.md`:
```markdown
# Frozen contracts (Wave 1 → Wave 2-4 anchor)

Wave 2 parallel tracks build against these. Changes require PR review.

- `src/contracts/llm.ts` — LLMProvider, ChatMsg, ChatOpts, ChatResult, ChatUsage, LLMHealth
- `src/contracts/embed.ts` — EmbedProvider, EmbedHealth
- `src/contracts/vector.ts` — VectorStore, VecFilter, VecHit
- `src/contracts/memory.ts` — Memory, MemoryType
- `src/contracts/job.ts` — Job, JobKind, JobState

Schema is frozen at migration `001-init`. New columns/tables = new migration file.
```

- [ ] **Step 3: Tag and commit**

```bash
git add README.md docs/contracts.md
git commit -m "docs: Wave 1 closeout — README + frozen-contracts index"
git tag wave-1-foundation
```

**Wave 1 done. Wave 2 fan-out can begin.**

---

## Wave 2 — Parallel fan-out (week 2, 4 tracks)

Each track is a self-contained brief. Track owner writes their own task plan from the brief using `superpowers:writing-plans` before implementation. Cross-track dependencies are limited to the contracts frozen in Wave 1.

### Track A — Pipeline + workers

**Owner:** agent-A
**Depends on:** Wave 1
**Estimate:** 1-1.5 weeks
**Deliverable:** jobs table machinery — workers consume pending jobs, run handlers, transition state, retry with backoff, mark poison on N attempts.

**Files to create:**
- `src/pipeline/job-repo.ts` — DAO for jobs table
- `src/pipeline/worker.ts` — poll loop, claim job, run handler, transition
- `src/pipeline/handlers/distill.ts` — stub (real impl in Wave 3)
- `src/pipeline/handlers/reembed.ts` — stub
- `src/pipeline/handlers/cleanup.ts` — implements 30-day prune
- `src/pipeline/registry.ts` — `register(kind, handler)` map
- `tests/pipeline/worker.test.ts`

**Contract this track produces:**
```ts
// src/pipeline/handler.ts (Wave 2 adds to contracts)
export interface JobHandler {
  kind: JobKind;
  handle(payload: unknown, ctx: HandlerCtx): Promise<void>;
}

export interface HandlerCtx {
  db: DB;
  config: Config;
  // Wave 3 adds: providers, vector, repos
}
```

**Acceptance:**
- Worker runs in-process via `startWorker(db, registry, {pollMs: 500})`.
- Pending job → handler called → state=completed.
- Throwing handler → state=failed, attempts++.
- 3 failures → state=poison.
- Stub `distill` handler just logs and completes (real impl Wave 3).

**Doctor check to add:** "No jobs in `running` state older than 1 hour."

### Track B — Search + recall

**Owner:** agent-B
**Depends on:** Wave 1
**Estimate:** 1 week
**Deliverable:** hybrid search via FTS5 + sqlite-vec, HTTP endpoints, CLI commands.

**Files to create:**
- `src/search/fuse.ts` — score fusion (α·bm25 + β·cosine + γ·importance + δ·freshness)
- `src/search/query.ts` — parser for filters (`type:`, `repo:`, `since:`)
- `src/server/routes/search.ts` — GET /search, POST /recall, POST /remember
- `src/server/routes/memory.ts` — GET /memory/:id
- `src/cli/search.ts` — CLI commands
- `tests/search/fuse.test.ts`
- `tests/server/search.test.ts`

**Note for Wave 2:** Until Track D ships an embed provider, search endpoint runs FTS-only path (β=0). Track D handoff swaps in real embedding. Test with mock EmbedProvider returning fixed vectors.

**Acceptance:**
- `GET /search?q=sqlite&limit=10` → array of hits with `{id, type, text, score, source}`.
- Filters: `type:decision`, `repo:foo`, `since:7d`.
- CLI: `astra-memory search "..."` prints table.
- `POST /remember` bypasses pipeline — direct insert + embed + FTS update.

**Doctor check to add:** "Search returns hits for a known-inserted fixture memory."

### Track C — Service install + Doctor v1

**Owner:** agent-C
**Depends on:** Wave 1
**Estimate:** 1 week
**Deliverable:** per-OS service install, doctor checks framework, `astra-memory service` + `doctor` CLI commands.

**Files to create:**
- `src/service/types.ts` — `ServiceAdapter` interface
- `src/service/systemd.ts`
- `src/service/launchd.ts`
- `src/service/schtasks.ts`
- `src/service/index.ts` — picks adapter by `platform()`
- `src/doctor/checks.ts` — array of `Check` functions
- `src/doctor/runner.ts` — runs all, prints table/JSON
- `src/cli/service.ts`
- `src/cli/doctor.ts`
- `tests/service/adapters.test.ts` (mock fs)
- `tests/doctor/runner.test.ts`

**Acceptance:**
- `astra-memory service install` writes correct unit file for current OS, registers with init system, exits 0.
- `astra-memory service status|start|stop|uninstall` work end-to-end.
- `astra-memory doctor` prints table:
  ```
  ✓ SQLite writable
  ✓ FTS5 + sqlite-vec loaded
  ✓ Daemon reachable :7777
  ✗ Ollama model qwen2.5-coder:7b not installed (run: ollama pull qwen2.5-coder:7b)
  ```
- `--json` mode emits machine-readable output.

**Doctor checks owned by this track (others add via PR):**
- SQLite writable, WAL on
- sqlite-vec + FTS5 loadable
- Daemon reachable on port
- Disk free > 1GB
- Service unit present if installed

### Track D — Providers ×4

**Owner:** agent-D (split into 2 sub-agents)
**Depends on:** Wave 1 contracts
**Estimate:** 1 week (parallel within track)

**Sub-track D1 — Ollama (LLM + Embed)**
- `src/providers/llm/ollama.ts` — implements `LLMProvider`
- `src/providers/embed/ollama.ts` — implements `EmbedProvider`
- `tests/providers/ollama-contract.test.ts` (uses mock HTTP)

**Sub-track D2 — Azure OpenAI (LLM + Embed)**
- `src/providers/llm/azure-openai.ts`
- `src/providers/embed/azure-openai.ts`
- `tests/providers/azure-contract.test.ts` (mock HTTP)

**Shared contract test:** all 4 impls share `tests/providers/_contract-suite.ts` parameterized by provider — ensures identical shape of returns.

**Cost tracking — implement in `chat()` returns:**
- Ollama: `usage.usd = 0`.
- Azure: compute from `response.usage.prompt_tokens` and `completion_tokens` × per-model price (table in `src/providers/llm/pricing.ts`).

**Acceptance:**
- Contract test passes for all 4 impls.
- Ollama LLM `chat()` round-trip works against local `ollama serve` in CI (gated `INTEGRATION_LIVE=1`, skipped by default).
- Azure mocked HTTP returns expected shape; live mode optional.
- Embed providers return `Float32Array` of exactly 1024 floats.

**Doctor checks to add:** "Configured LLM provider responds within 5s." / "Configured embed provider returns 1024-dim vector."

### Wave 2 closeout

- All 4 tracks merged into main of `astramemory-local`.
- Run full test suite.
- Tag `wave-2-fanout`.

---

## Wave 3 — Distillation engine (week 3, single owner)

**Owner:** agent-distill
**Depends on:** Tracks A (worker) + D (providers) + Track B (for tests)
**Estimate:** 2-3 weeks (compressible to 1.5 if A+D ship clean)

**Deliverable:** 8-stage distillation pipeline behind `distill` job handler. Replace Track A's stub.

**Files to create:**
- `src/distill/stages/01-cleanup.ts`
- `src/distill/stages/02-normalize.ts`
- `src/distill/stages/03-chunk.ts`
- `src/distill/stages/04-compact.ts`
- `src/distill/stages/05-extract.ts`
- `src/distill/stages/06-reduce.ts`
- `src/distill/stages/07-memory-normalize.ts`
- `src/distill/stages/08-embed-index.ts`
- `src/distill/pipeline.ts` — runs stages 1→8 with intermediate artifact persistence
- `src/distill/prompts/extract.ts` — extraction prompt + Zod schema for atom JSON
- `src/budget/tracker.ts` — daily spend check + record
- `tests/distill/*.test.ts` — one per stage + integration
- Modify: `src/pipeline/handlers/distill.ts` — wire to pipeline

**Stages spec (from design §9 + §10):**
- 1 cleanup — regex dedup, whitespace, repeated tool output. Deterministic.
- 2 normalize — paths, timestamps, agent names → canonical. Deterministic.
- 3 chunk — token-aware split, ~800 tok, respect turn boundaries. Deterministic.
- 4 compact — LLM call per chunk, removes redundancy. Uses `config.llm.compaction`.
- 5 extract — LLM JSON-mode per chunk, emits typed atoms `{type, text, importance, confidence, evidence}`. Zod-validated. Retry once on parse fail.
- 6 reduce — merge atoms by content hash across chunks.
- 7 memory-normalize — apply canonical text rules, compute final hash.
- 8 embed-index — embed via configured provider, write memories row + vec row.

**Budget tracker:**
- Before each LLM call: `if (todaySpend + estimatedCost > cap) → throw BudgetExceeded`.
- `BudgetExceeded` → job moves to `paused` (not `failed`).
- After each call: `record(usd)`.
- `astra-memory budget` CLI prints today + month.
- `astra-memory budget --reset` clears today (logged).

**Extraction prompt schema (Zod):**
```ts
export const AtomSchema = z.object({
  type: z.enum(['decision', 'fact', 'lesson', 'command', 'todo']),
  text: z.string().min(5).max(500),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  evidence: z.string().optional()
});
export const ExtractionSchema = z.object({
  atoms: z.array(AtomSchema)
});
```

**Acceptance:**
- Fixture transcript (10 turns about "use sqlite-vec for v1") → distillation produces 1+ atom of type `decision`.
- All 8 stage tests pass.
- Pipeline test: ingest → wait for worker → search returns memory.
- Budget cap triggers `paused` state.

**Doctor check to add:** "Distillation queue not stuck (no pending older than 1h with worker running)."

---

## Wave 4 — Integration + polish (week 4)

### Track W4-A — Install wizard

**Owner:** agent-wizard
**Depends on:** C + D
**Estimate:** 2 days

**Files:**
- `src/cli/init.ts` — replace stub
- `src/cli/token.ts` — `astra-memory token rotate` (32-byte random hex, rewrites secrets.env, prints export line)
- `src/config/writer.ts` — emits `config.yaml`
- `tests/cli/init.test.ts` — non-TTY automated path
- `tests/cli/token.test.ts` — rotate generates fresh token + writes 0600 file

Use `@inquirer/prompts`. Conditional checks per provider choice. Writes `config.yaml` + `secrets.env` (mode 0600) + generates Bearer token + runs migrations + runs doctor + prints next-steps. Wizard shape from design §13.

### Track W4-B — Cross-OS CI

**Owner:** agent-ci
**Depends on:** all prior waves landed
**Estimate:** 1 day

**Files:**
- `.github/workflows/test.yml` — matrix ubuntu-latest, macos-latest, windows-latest × node-20, node-22.

Run `npm test`, gate on green. Install sqlite-vec prebuilt per OS (verify Windows path quirks).

### Track W4-C — E2E plugin integration

**Owner:** agent-e2e
**Depends on:** Wave 3
**Estimate:** 2 days

**Files:**
- `tests/e2e/plugin-flow.test.ts`

Spin daemon. Invoke the actual `astramemory-plugin/hooks/scripts/_ingest-transcript.sh` script with `MEMORY_API_URL=http://127.0.0.1:PORT` + `MEMORY_BEARER=...`. Verify session → distillation → search hit. Document the env-swap in plugin's README.

### Track W4-D — Docs + migration guide

**Owner:** agent-docs
**Depends on:** all prior
**Estimate:** 1 day

**Files:**
- `astramemory-local/README.md` — full version
- `astramemory-local/docs/migration-from-saas.md` — how to swap plugin to local
- `astramemory-plugin/README.md` — add `## Local backend` section

### Wave 4 closeout

- Tag `v0.1.0-rc.1` in astramemory-local.
- Cut a release.
- Update plugin README pointing at local backend option.

---

## Risks during execution

1. **sqlite-vec native binary on Windows** — Wave 1 owner runs Windows CI smoke before Wave 2 fan-out. If broken, halt Wave 2 until fixed.
2. **Qwen JSON-mode flakiness** — Wave 3 owner builds Zod-retry into stage 5 from day 1; budget for ~10% retry rate.
3. **Track interface drift** — frozen contracts file. Any PR touching `src/contracts/*` requires explicit reviewer sign-off.
4. **Worker contention with HTTP** — single Node process means CPU-bound LLM calls block HTTP. Mitigate: Ollama is HTTP-out (non-blocking). For Azure same. Real risk is heavy embed batching — defer to v1.1 if it shows up.

## Done definition

- [ ] Plugin user runs `astra-memory init`, picks Ollama, runs `astra-memory service install`.
- [ ] User exports `MEMORY_API_URL=http://127.0.0.1:7777` + `MEMORY_BEARER=...`.
- [ ] Plugin session triggers PreCompact hook → local daemon ingests → distillation runs → `/recall "what did we decide?"` returns relevant memory.
- [ ] Cross-OS CI green on ubuntu+macos+windows.
- [ ] Doctor reports all green.
- [ ] README + migration guide published.

---

## Execution choice

**Plan saved to `docs/superpowers/plans/2026-06-27-astramemory-local-v1-waves.md`.**

Two execution options:

1. **Subagent-Driven (recommended for Wave 2+)** — fresh subagent per task, review between, fast iteration. Required for the parallel waves.
2. **Inline Execution** — execute tasks in this session via `superpowers:executing-plans`. Best for Wave 1 (sequential, blocking).

Recommended split: Wave 1 inline (need tight control of contract freeze), Waves 2-4 subagent-driven (built for parallelism). Confirm and we proceed.
