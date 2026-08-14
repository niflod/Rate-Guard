export interface AppConfig {
  readonly providerBaseUrl: string;
  readonly providerApiKey: string;
  readonly rpmLimit: number;
  readonly tpmLimit: number;
  readonly queueConcurrency: number;
  readonly maxRetries: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  /**
   * Safety margin factor (0 < margin <= 1) applied to the limits announced
   * by the provider. Default 0.8 — operating at 80% of the ceiling absorbs
   * provider peak windows.
   */
  readonly safetyMargin: number;
}

function parseEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid environment variable: ${name}=${raw}`);
  }
  return parsed;
}

function parseFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid environment variable: ${name}=${raw}`);
  }
  return parsed;
}

function parseString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw;
}

export function loadConfig(): AppConfig {
  return {
    providerBaseUrl: parseString("PROVIDER_BASE_URL", "https://api.openai.com/v1"),
    providerApiKey: parseString("PROVIDER_API_KEY", ""),
    rpmLimit: parseEnv("RPM_LIMIT", 500),
    tpmLimit: parseEnv("TPM_LIMIT", 90_000),
    queueConcurrency: parseEnv("QUEUE_CONCURRENCY", 1),
    maxRetries: parseEnv("MAX_RETRIES", 8),
    baseBackoffMs: parseEnv("BASE_BACKOFF_MS", 1000),
    maxBackoffMs: parseEnv("MAX_BACKOFF_MS", 60_000),
    safetyMargin: parseFloat("SAFETY_MARGIN", 0.8, 0.01, 1.0),
  };
}
