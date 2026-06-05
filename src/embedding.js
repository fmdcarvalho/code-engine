export const DEFAULT_EMBEDDING_PROVIDER = "local-hash-v1";
export const DEFAULT_VECTOR_DIMS = 384;
export const OLLAMA_EMBEDDING_PROVIDER = "ollama";
export const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
export const DEFAULT_OLLAMA_VECTOR_DIMS = 768;
export const OPENAI_COMPAT_EMBEDDING_PROVIDER = "openai-compatible";
export const DEFAULT_OPENAI_COMPAT_VECTOR_DIMS = 1536;

export function createEmbeddingProvider(options = {}) {
  if (typeof options.embed === "function") {
    return normalizeCustomProvider(options);
  }

  const provider = options.provider ?? options.name ?? DEFAULT_EMBEDDING_PROVIDER;
  const providerName = String(provider);

  if (providerName === DEFAULT_EMBEDDING_PROVIDER || providerName === "local-hash") {
    const dims = parsePositiveInteger(options.dims ?? DEFAULT_VECTOR_DIMS, "embedding dims");
    return {
      name: DEFAULT_EMBEDDING_PROVIDER,
      dims,
      embed: (text) => embedText(text, dims),
    };
  }

  if (providerName === OLLAMA_EMBEDDING_PROVIDER || providerName.startsWith(`${OLLAMA_EMBEDDING_PROVIDER}:`)) {
    return createOllamaEmbeddingProvider({ ...options, provider: providerName });
  }

  if (
    providerName === OPENAI_COMPAT_EMBEDDING_PROVIDER
    || providerName.startsWith(`${OPENAI_COMPAT_EMBEDDING_PROVIDER}:`)
  ) {
    return createOpenAiCompatibleEmbeddingProvider({ ...options, provider: providerName });
  }

  throw new Error(`Unknown embedding provider: ${provider}`);
}

export function normalizeEmbeddingProvider(provider) {
  if (!provider) return createEmbeddingProvider();
  if (typeof provider.embed === "function") return normalizeCustomProvider(provider);
  return createEmbeddingProvider(provider);
}

export function tokenize(text) {
  return String(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z_][a-z0-9_]{1,}|[0-9]+/g) || [];
}

export function embedText(text, dims = DEFAULT_VECTOR_DIMS) {
  const vector = new Array(dims).fill(0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const index = positiveHash(token) % dims;
    const sign = positiveHash(`sign:${token}`) % 2 === 0 ? 1 : -1;
    vector[index] += sign * tokenWeight(token);
  }

  return normalize(vector);
}

function normalizeCustomProvider(provider) {
  const name = provider.name || provider.provider;
  const dims = parsePositiveInteger(provider.dims, "embedding dims");
  if (!name) throw new Error("Custom embedding provider must include a name.");

  return {
    name,
    dims,
    async embed(text) {
      const vector = await provider.embed(text);
      return normalizeEmbeddingVector(vector, dims, name);
    },
  };
}

function createOllamaEmbeddingProvider(options) {
  const provider = String(options.provider || OLLAMA_EMBEDDING_PROVIDER);
  const modelFromProvider = provider.startsWith(`${OLLAMA_EMBEDDING_PROVIDER}:`)
    ? provider.slice(OLLAMA_EMBEDDING_PROVIDER.length + 1)
    : "";
  const model = options.model
    || modelFromProvider
    || process.env.CONTEXT_ENGINE_OLLAMA_MODEL
    || process.env.OLLAMA_EMBEDDING_MODEL
    || DEFAULT_OLLAMA_EMBEDDING_MODEL;
  if (!model) throw new Error("Ollama embedding provider requires a model.");

  const dims = parsePositiveInteger(
    options.dims
      ?? process.env.CONTEXT_ENGINE_OLLAMA_DIMS
      ?? process.env.OLLAMA_EMBEDDING_DIMS
      ?? DEFAULT_OLLAMA_VECTOR_DIMS,
    "embedding dims",
  );
  const baseUrl = normalizeBaseUrl(
    options.baseUrl
      || options.url
      || process.env.CONTEXT_ENGINE_OLLAMA_URL
      || process.env.OLLAMA_HOST
      || "http://127.0.0.1:11434",
  );
  const fetchFn = options.fetch || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("Ollama embedding provider requires fetch support.");
  }

  const name = `${OLLAMA_EMBEDDING_PROVIDER}:${model}`;
  return {
    name,
    dims,
    async embed(text) {
      const response = await requestEmbedding(fetchFn, `${baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: String(text) }),
      }, name);
      if (!response?.ok) {
        const status = response?.status ? ` HTTP ${response.status}` : "";
        throw new Error(`Ollama embedding request failed for ${name}.${status}`);
      }
      const payload = await response.json();
      return normalizeEmbeddingVector(ollamaVectorFromPayload(payload), dims, name);
    },
  };
}

function createOpenAiCompatibleEmbeddingProvider(options) {
  const provider = String(options.provider || OPENAI_COMPAT_EMBEDDING_PROVIDER);
  const modelFromProvider = provider.startsWith(`${OPENAI_COMPAT_EMBEDDING_PROVIDER}:`)
    ? provider.slice(OPENAI_COMPAT_EMBEDDING_PROVIDER.length + 1)
    : "";
  const model = options.model
    || modelFromProvider
    || process.env.CONTEXT_ENGINE_OPENAI_COMPAT_MODEL
    || process.env.OPENAI_EMBEDDING_MODEL;
  if (!model) {
    throw new Error("OpenAI-compatible embedding provider requires a model.");
  }

  const dims = parsePositiveInteger(
    options.dims
      ?? process.env.CONTEXT_ENGINE_OPENAI_COMPAT_DIMS
      ?? process.env.OPENAI_EMBEDDING_DIMS
      ?? DEFAULT_OPENAI_COMPAT_VECTOR_DIMS,
    "embedding dims",
  );
  const baseUrl = normalizeBaseUrl(
    options.baseUrl
      || options.url
      || process.env.CONTEXT_ENGINE_OPENAI_COMPAT_URL,
  );
  const apiKey = options.apiKey ?? process.env.CONTEXT_ENGINE_OPENAI_COMPAT_API_KEY;
  const fetchFn = options.fetch || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("OpenAI-compatible embedding provider requires fetch support.");
  }

  const name = `${OPENAI_COMPAT_EMBEDDING_PROVIDER}:${model}`;
  return {
    name,
    dims,
    async embed(text) {
      const headers = { "content-type": "application/json" };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const response = await requestEmbedding(fetchFn, `${baseUrl}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, input: String(text) }),
      }, name);
      if (!response?.ok) {
        const status = response?.status ? ` HTTP ${response.status}` : "";
        throw new Error(`OpenAI-compatible embedding request failed for ${name}.${status}`);
      }
      const payload = await response.json();
      return normalizeEmbeddingVector(openAiCompatibleVectorFromPayload(payload), dims, name);
    },
  };
}

async function requestEmbedding(fetchFn, url, options, providerName) {
  try {
    return await fetchFn(url, options);
  } catch (error) {
    throw new Error(`Embedding request failed for ${providerName}: ${error.message}`);
  }
}

function ollamaVectorFromPayload(payload) {
  if (Array.isArray(payload?.embeddings?.[0])) return payload.embeddings[0];
  if (Array.isArray(payload?.embedding)) return payload.embedding;
  throw new Error("Ollama embedding response did not include an embedding vector.");
}

function openAiCompatibleVectorFromPayload(payload) {
  if (Array.isArray(payload?.data?.[0]?.embedding)) return payload.data[0].embedding;
  if (Array.isArray(payload?.embedding)) return payload.embedding;
  throw new Error("OpenAI-compatible embedding response did not include an embedding vector.");
}

function normalizeEmbeddingVector(vector, dims, providerName) {
  if (!Array.isArray(vector)) {
    throw new Error(`Embedding provider ${providerName} returned a non-array vector.`);
  }
  if (vector.length !== dims) {
    throw new Error(`Embedding provider ${providerName} returned ${vector.length} dims, expected ${dims}.`);
  }

  return vector.map((value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Error(`Embedding provider ${providerName} returned a non-numeric vector value.`);
    }
    return numeric;
  });
}

function normalizeBaseUrl(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("Embedding provider requires a base URL.");
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  return withProtocol.replace(/\/+$/, "");
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

export function cosineSimilarity(left, right) {
  const size = Math.min(left.length, right.length);
  let score = 0;
  for (let index = 0; index < size; index += 1) {
    score += left[index] * right[index];
  }
  return score;
}

export function parseVector(serialized) {
  if (Array.isArray(serialized)) return serialized;
  return JSON.parse(serialized);
}

function tokenWeight(token) {
  if (token.length > 16) return 1.3;
  if (token.includes("_")) return 1.2;
  return 1;
}

function normalize(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm) return vector;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

function positiveHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
