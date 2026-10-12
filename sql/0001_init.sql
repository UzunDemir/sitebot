-- sitebot: initial schema for the embeddable RAG assistant platform
-- Run this in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
--
-- Design notes:
--   * Access model: the browser NEVER talks to Supabase directly.
--     All reads/writes go through the Next.js server using the service role key.
--     RLS is enabled with NO anon/authenticated policies (defense in depth).
--   * Hybrid search: pgvector (HNSW) for semantic + tsvector/GIN for lexical.
--     Text search config is 'russian' (handles RU stemming; Latin tokens pass through).
--   * Embeddings: vector(1536) — Gemini gemini-embedding-001 with outputDimensionality=1536.
--     If you switch embedding provider/dimension, update the vector(N) columns
--     and function signatures, then re-run the seed script (full re-index).

-- ============================================================ extensions
create extension if not exists vector;
create extension if not exists pgcrypto;

-- ============================================================ bots
create table if not exists bots (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  public_key text not null unique default ('pk_' || encode(gen_random_bytes(12), 'hex')),
  model_id text not null default 'deepseek:deepseek-flash',
  system_prompt text not null default '',
  temperature real not null default 0.2,
  thinking_enabled boolean not null default false,
  top_k int not null default 6,
  greeting text,
  theme jsonb not null default '{}'::jsonb,
  allowed_origins text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ============================================================ documents
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references bots(id) on delete cascade,
  title text not null,
  source text,
  mime text not null default 'text/markdown',
  content text not null,
  content_hash text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'ready', 'error')),
  error text,
  chunk_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bot_id, content_hash)
);

-- ============================================================ chunks
create table if not exists chunks (
  id bigserial primary key,
  bot_id uuid not null references bots(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  idx int not null,
  content text not null,
  embedding vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists chunks_bot_idx on chunks (bot_id);
create index if not exists chunks_document_idx on chunks (document_id);
create index if not exists chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_fts_idx on chunks using gin (to_tsvector('russian', content));

-- ============================================================ conversations
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references bots(id) on delete cascade,
  session_key text not null,
  visitor jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  unique (bot_id, session_key)
);

-- ============================================================ messages
create table if not exists messages (
  id bigserial primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  citations jsonb not null default '[]'::jsonb,
  model text,
  input_tokens int,
  output_tokens int,
  cost_usd numeric(12, 6),
  latency_ms int,
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_idx on messages (conversation_id, created_at);

-- ============================================================ feedback
create table if not exists feedback (
  id bigserial primary key,
  message_id bigint not null references messages(id) on delete cascade,
  rating smallint not null check (rating in (-1, 1)),
  comment text,
  created_at timestamptz not null default now()
);

-- ============================================================ quota counters
create table if not exists quota_counters (
  bot_id uuid not null references bots(id) on delete cascade,
  day date not null default current_date,
  requests int not null default 0,
  tokens int not null default 0,
  primary key (bot_id, day)
);

-- ============================================================ vector search
create or replace function match_chunks (
  p_bot_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 8
)
returns table (
  chunk_id bigint,
  document_id uuid,
  content text,
  idx int,
  similarity float
)
language sql
stable
as $$
  select
    c.id as chunk_id,
    c.document_id,
    c.content,
    c.idx,
    (1 - (c.embedding <=> p_query_embedding))::float as similarity
  from chunks c
  where c.bot_id = p_bot_id
    and c.embedding is not null
  order by c.embedding <=> p_query_embedding
  limit p_match_count;
$$;

-- ============================================================ full-text search
create or replace function search_chunks_fts (
  p_bot_id uuid,
  p_query text,
  p_match_count int default 8
)
returns table (
  chunk_id bigint,
  document_id uuid,
  content text,
  idx int,
  rank float
)
language sql
stable
as $$
  select
    c.id as chunk_id,
    c.document_id,
    c.content,
    c.idx,
    ts_rank(
      to_tsvector('russian', c.content),
      websearch_to_tsquery('russian', p_query)
    )::float as rank
  from chunks c
  where c.bot_id = p_bot_id
    and to_tsvector('russian', c.content) @@ websearch_to_tsquery('russian', p_query)
  order by rank desc
  limit p_match_count;
$$;

-- ============================================================ RLS
-- Enabled with zero policies: only the service role (server-side) can access.
alter table bots enable row level security;
alter table documents enable row level security;
alter table chunks enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table feedback enable row level security;
alter table quota_counters enable row level security;

-- ============================================================ verification
select 'sitebot schema v1 installed' as result,
       (select count(*) from pg_tables where tablename in
         ('bots','documents','chunks','conversations','messages','feedback','quota_counters')
       ) as tables_created;
