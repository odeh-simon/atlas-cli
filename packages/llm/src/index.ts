export const llmPackage = "@atlas/llm";

export type AiProviderKind = "ollama" | "openai-compatible";

export interface AiProviderConfig {
  readonly alias: string;
  readonly provider: AiProviderKind;
  readonly baseUrl: string;
  readonly model: string;
  readonly tokenAlias?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxInputTokens?: number | undefined;
}

export interface AiProviderHealth {
  readonly alias: string;
  readonly provider: AiProviderKind;
  readonly configured: boolean;
  readonly status: "configured" | "unreachable" | "invalid";
  readonly model: string;
  readonly baseUrl: string;
  readonly detail: string;
}

export interface AiModel {
  readonly name: string;
  readonly modifiedAt?: string | undefined;
}

export interface AiCompletionMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface AiCompletionRequest {
  readonly provider: AiProviderConfig;
  readonly messages: readonly AiCompletionMessage[];
  readonly temperature?: number | undefined;
  readonly responseFormat?: "json" | "text" | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface AiCompletionResponse {
  readonly providerAlias: string;
  readonly model: string;
  readonly content: string;
}

export interface AiProviderRuntimeOptions {
  readonly fetchImpl?: typeof fetch | undefined;
}

export async function getAiProviderHealth(
  provider: AiProviderConfig,
  options: AiProviderRuntimeOptions = {}
): Promise<AiProviderHealth> {
  const validation = validateProviderConfig(provider);
  if (validation !== undefined) {
    return {
      alias: provider.alias,
      provider: provider.provider,
      configured: false,
      status: "invalid",
      model: provider.model,
      baseUrl: provider.baseUrl,
      detail: validation
    };
  }

  if (provider.provider !== "ollama") {
    return {
      alias: provider.alias,
      provider: provider.provider,
      configured: false,
      status: "invalid",
      model: provider.model,
      baseUrl: provider.baseUrl,
      detail: "Provider is not implemented yet"
    };
  }

  try {
    const models = await listAiModels(provider, options);
    const hasModel = models.some((model) => model.name === provider.model);
    return {
      alias: provider.alias,
      provider: provider.provider,
      configured: hasModel,
      status: hasModel ? "configured" : "unreachable",
      model: provider.model,
      baseUrl: normalizeBaseUrl(provider.baseUrl),
      detail: hasModel ? "ollama model available" : `ollama model not found: ${provider.model}`
    };
  } catch (error) {
    return {
      alias: provider.alias,
      provider: provider.provider,
      configured: false,
      status: "unreachable",
      model: provider.model,
      baseUrl: normalizeBaseUrl(provider.baseUrl),
      detail: error instanceof Error ? redactSecretText(error.message) : "ollama health check failed"
    };
  }
}

export async function listAiModels(
  provider: AiProviderConfig,
  options: AiProviderRuntimeOptions = {}
): Promise<readonly AiModel[]> {
  assertSupportedProvider(provider);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchWithTimeout(
    `${normalizeBaseUrl(provider.baseUrl)}/api/tags`,
    { method: "GET" },
    provider.timeoutMs,
    fetchImpl
  );
  if (!response.ok) {
    throw new Error(`Ollama model request failed: ${response.status}`);
  }
  const payload = asRecord(await response.json(), "Ollama model response must be an object");
  const models = Array.isArray(payload.models) ? payload.models : [];
  return models.map(normalizeOllamaModel).sort((a, b) => a.name.localeCompare(b.name));
}

export async function createAiCompletion(input: AiCompletionRequest): Promise<AiCompletionResponse> {
  assertSupportedProvider(input.provider);
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchWithTimeout(
    `${normalizeBaseUrl(input.provider.baseUrl)}/api/chat`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: input.provider.model,
        stream: false,
        messages: input.messages,
        options: input.temperature === undefined ? undefined : { temperature: input.temperature },
        format: input.responseFormat === "json" ? "json" : undefined
      })
    },
    input.provider.timeoutMs,
    fetchImpl
  );
  if (!response.ok) {
    throw new Error(`Ollama completion request failed: ${response.status}`);
  }
  const payload = asRecord(await response.json(), "Ollama completion response must be an object");
  const message = asRecord(payload.message, "Ollama completion response message must be an object");
  const content = typeof message.content === "string" ? message.content : "";
  return {
    providerAlias: input.provider.alias,
    model: input.provider.model,
    content
  };
}

export function redactSecretText(value: string): string {
  return value.replace(/(?:Bearer\s+)?[A-Za-z0-9_=-]{32,}/g, "[REDACTED]");
}

export function defaultOllamaProvider(): AiProviderConfig {
  return {
    alias: "ollama.local",
    provider: "ollama",
    baseUrl: "http://localhost:11434",
    model: "qwen2.5-coder:7b",
    timeoutMs: 10_000
  };
}

function validateProviderConfig(provider: AiProviderConfig): string | undefined {
  if (!/^[A-Za-z0-9_.:-]+$/.test(provider.alias)) return "Invalid provider alias";
  if (provider.provider !== "ollama" && provider.provider !== "openai-compatible") return "Invalid provider kind";
  if (provider.model.trim().length === 0) return "Model is required";
  try {
    const url = new URL(provider.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "Provider baseUrl must be HTTP(S)";
  } catch {
    return "Provider baseUrl must be a valid URL";
  }
  if (provider.timeoutMs !== undefined && provider.timeoutMs < 1) return "timeoutMs must be positive";
  if (provider.maxInputTokens !== undefined && provider.maxInputTokens < 1) return "maxInputTokens must be positive";
  return undefined;
}

function assertSupportedProvider(provider: AiProviderConfig): void {
  const validation = validateProviderConfig(provider);
  if (validation !== undefined) throw new TypeError(validation);
  if (provider.provider !== "ollama") {
    throw new TypeError("Only Ollama providers are implemented in this batch");
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined,
  fetchImpl: typeof fetch
): Promise<Response> {
  if (timeoutMs === undefined) return await fetchImpl(url, init);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeOllamaModel(value: unknown): AiModel {
  const record = asRecord(value, "Ollama model must be an object");
  const name = typeof record.name === "string" ? record.name : "";
  if (name.length === 0) throw new TypeError("Ollama model name is required");
  return {
    name,
    ...(typeof record.modified_at === "string" ? { modifiedAt: record.modified_at } : {})
  };
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new TypeError(message);
  return value as Record<string, unknown>;
}
