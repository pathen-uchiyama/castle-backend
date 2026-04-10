-- Strategy Engine Tables
CREATE TABLE IF NOT EXISTS strategy_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    condition TEXT NOT NULL,
    outcome TEXT NOT NULL,
    confidence INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logic_conflicts (
    id TEXT PRIMARY KEY,
    rules TEXT[] NOT NULL,
    conflict TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategy_personas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    pacing TEXT NOT NULL,
    thrill TEXT NOT NULL,
    rules TEXT[] NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS external_intelligence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    platform TEXT NOT NULL,
    author TEXT NOT NULL,
    link TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- RAG Management Tables
CREATE TABLE IF NOT EXISTS rag_documents (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('Itinerary', 'Policy', 'Logistics', 'Behavioral')),
    last_indexed TEXT NOT NULL,
    embeddings INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('Synced', 'Pending', 'Error')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
