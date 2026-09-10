import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ProcessFailure, runProcess } from './process.js';

export class CodexProviderError extends Error {}
export interface CodexProviderOptions {
  /** Tests can inject settings. Production reads process.env at each invocation. */
  environment?: NodeJS.ProcessEnv;
  /** Explicit opt-in only; no credentials file is discovered or sourced automatically. */
  envFile?: string;
}
export interface CodexProvider {
  mode: 'native' | 'custom';
  label: string;
  args: string[];
  /** Contains secrets. Pass only to the runner; never log or serialize this field. */
  environment: NodeJS.ProcessEnv;
  redact(value: string): string;
}
const providerId = 'gecco_explicit';
const keys = ['OPENAI_BASE_URL', 'OPENAI_API_KEY'] as const;

/** A small literal-only dotenv reader. Other keys and shell commands are never imported. */
export function parseProviderEnvironment(contents: string): Partial<Record<typeof keys[number], string>> {
  const values: Partial<Record<typeof keys[number], string>> = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(OPENAI_BASE_URL|OPENAI_API_KEY)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1] as typeof keys[number];
    if (values[key] !== undefined) throw new CodexProviderError('The AI environment file contains duplicate OpenAI settings.');
    let value = match[2];
    if (value.startsWith("'")) {
      const quoted = value.match(/^'([^']*)'\s*(?:#.*)?$/);
      if (!quoted) throw new CodexProviderError('The AI environment file contains an invalid quoted OpenAI setting.');
      value = quoted[1];
    } else if (value.startsWith('"')) {
      const quoted = value.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/);
      if (!quoted) throw new CodexProviderError('The AI environment file contains an invalid quoted OpenAI setting.');
      try { value = JSON.parse(quoted[1]) as string; } catch { throw new CodexProviderError('The AI environment file contains an invalid quoted OpenAI setting.'); }
    } else value = value.replace(/\s+#.*$/, '').trim();
    values[key] = value;
  }
  return values;
}
async function readSettings(path: string) {
  const actual = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  let file;
  try {
    file = await open(actual, 'r');
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > 65_536) throw new CodexProviderError('The AI environment file must be a regular file of at most 64 KiB.');
    const buffer = Buffer.alloc(65_537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65_536) throw new CodexProviderError('The AI environment file exceeds its size limit.');
    return parseProviderEnvironment(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch (error) {
    if (error instanceof CodexProviderError) throw error;
    throw new CodexProviderError('The configured AI environment file could not be read. No alternate authentication was attempted.');
  } finally { await file?.close(); }
}
export async function resolveCodexProvider(options: CodexProviderOptions = {}): Promise<CodexProvider> {
  const environment = { ...(options.environment ?? process.env) };
  const envFile = options.envFile ?? environment.GECCO_AI_ENV_FILE;
  const settings = envFile ? await readSettings(envFile) : {};
  for (const key of keys) if (settings[key] !== undefined) environment[key] = settings[key];
  const key = environment.OPENAI_API_KEY;
  const secrets = key ? [...new Set([key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)])].sort((a, b) => b.length - a.length) : [];
  const redact = (value: string) => {
    let result = value;
    for (const secret of secrets) result = result.replaceAll(secret, '[credential omitted]');
    return result.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [credential omitted]');
  };
  const explicit = envFile !== undefined || keys.some(name => environment[name] !== undefined);
  if (!explicit) return { mode: 'native', label: 'OpenAI via Codex CLI', args: [], environment, redact };
  const base = environment.OPENAI_BASE_URL;
  if (!base || !key) throw new CodexProviderError('Explicit AI configuration requires both OPENAI_BASE_URL and OPENAI_API_KEY. No alternate authentication was attempted.');
  if (key.length > 16_384 || /[\s\x00-\x1f\x7f]/.test(key)) throw new CodexProviderError('The configured OpenAI API key has an invalid format.');
  let url: URL;
  try { url = new URL(base); } catch { throw new CodexProviderError('OPENAI_BASE_URL must be a valid HTTPS API endpoint.'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash
    || base.length > 2048 || /[\x00-\x20\x7f]/.test(base)) throw new CodexProviderError('OPENAI_BASE_URL must use HTTPS (or loopback HTTP), without credentials, query parameters, or fragments.');
  const baseURL = url.href.replace(/\/$/, '');
  environment.OPENAI_BASE_URL = baseURL;
  // Only a variable name enters command arguments. No auth.json/config.toml is read or written here.
  const config: Record<string, string | boolean | number> = {
    model_provider: providerId,
    [`model_providers.${providerId}.name`]: 'Explicit OpenAI-compatible endpoint',
    [`model_providers.${providerId}.base_url`]: baseURL,
    [`model_providers.${providerId}.env_key`]: 'OPENAI_API_KEY',
    [`model_providers.${providerId}.wire_api`]: 'responses',
    [`model_providers.${providerId}.requires_openai_auth`]: false,
    [`model_providers.${providerId}.supports_websockets`]: false,
    [`model_providers.${providerId}.request_max_retries`]: 0,
    [`model_providers.${providerId}.stream_max_retries`]: 0,
  };
  return { mode: 'custom', label: 'Configured Responses endpoint via Codex CLI', environment, redact,
    args: Object.entries(config).flatMap(([name, value]) => ['-c', `${name}=${JSON.stringify(value)}`]) };
}

/** Redacts the runner boundary before callers can persist stderr, output, or failure details. */
export async function runWithCodexProvider(provider: CodexProvider, command: string, args: string[],
  options: Parameters<typeof runProcess>[2], runner: typeof runProcess = runProcess) {
  try {
    const result = await runner(command, [...provider.args, ...args], { ...options, env: provider.environment });
    return { stdout: provider.redact(result.stdout), stderr: provider.redact(result.stderr) };
  } catch (error) {
    if (error instanceof ProcessFailure) {
      const capture = error.capture ? { ...error.capture, stdout: provider.redact(error.capture.stdout), stderr: provider.redact(error.capture.stderr) } : undefined;
      throw new ProcessFailure(error.kind, provider.redact(error.details), capture);
    }
    throw new CodexProviderError('The configured AI runner did not complete. No alternate provider was attempted.');
  }
}
