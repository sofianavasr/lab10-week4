create extension if not exists vector;

create table public.memories (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in ('episodic', 'semantic', 'procedural')),
  content text not null,
  embedding vector(1536) not null,
  retrieval_count integer not null default 0,
  created_at timestamptz not null default now(),
  last_retrieved_at timestamptz
);

create index memories_user_id_idx on public.memories(user_id);
create index memories_embedding_cosine_idx
  on public.memories
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

alter table public.memories enable row level security;

create policy "Users can manage own memories"
  on public.memories for all
  using (auth.uid() = user_id);

create or replace function public.match_memories(
  p_user_id uuid,
  p_query_embedding vector(1536),
  p_match_count integer default 6
)
returns table (
  id uuid,
  user_id uuid,
  type text,
  content text,
  retrieval_count integer,
  created_at timestamptz,
  last_retrieved_at timestamptz,
  similarity double precision
)
language sql
stable
as $$
  select
    m.id,
    m.user_id,
    m.type,
    m.content,
    m.retrieval_count,
    m.created_at,
    m.last_retrieved_at,
    1 - (m.embedding <=> p_query_embedding) as similarity
  from public.memories m
  where m.user_id = p_user_id
  order by m.embedding <=> p_query_embedding
  limit greatest(1, least(coalesce(p_match_count, 6), 8));
$$;

create or replace function public.increment_memory_retrieval(
  p_memory_ids uuid[],
  p_last_retrieved_at timestamptz default now()
)
returns void
language plpgsql
as $$
begin
  if p_memory_ids is null or array_length(p_memory_ids, 1) is null then
    return;
  end if;

  update public.memories
  set
    retrieval_count = retrieval_count + 1,
    last_retrieved_at = p_last_retrieved_at
  where id = any(p_memory_ids);
end;
$$;
