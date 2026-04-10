-- Enable the vector extension
create extension if not exists vector;

-- Create the knowledge_vectors table
create table if not exists public.knowledge_vectors (
  id text primary key,
  content text not null,
  metadata jsonb,
  embedding vector(1536),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS
alter table public.knowledge_vectors enable row level security;

-- Create policies (Backend strictly uses service_role key, but good practice to secure public)
create policy "Enable read access for all users" on public.knowledge_vectors
  for select using (true);
  
-- Create a function to similarity search vectors
create or replace function match_knowledge_vectors (
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
returns table (
  id text,
  content text,
  metadata jsonb,
  similarity float
)
language sql stable
as $$
  select
    knowledge_vectors.id,
    knowledge_vectors.content,
    knowledge_vectors.metadata,
    1 - (knowledge_vectors.embedding <=> query_embedding) as similarity
  from public.knowledge_vectors
  where 1 - (knowledge_vectors.embedding <=> query_embedding) > match_threshold
  order by knowledge_vectors.embedding <=> query_embedding
  limit match_count;
$$;
