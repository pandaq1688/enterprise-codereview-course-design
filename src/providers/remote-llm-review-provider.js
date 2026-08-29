import fs from 'node:fs/promises';
import { AppError } from '../shared/app-error.js';
import { ErrorCodes } from '../shared/error-codes.js';

/**
 * OpenAI-compatible Remote LLM ReviewProvider.
 * POST {baseUrl}/v1/chat/completions — never log API key or Authorization values.
 *
 * @param {{
 *   baseUrl: string,
 *   model: string,
 *   apiKeyEnv: string,
 *   timeoutMs: number,
 *   fetchImpl?: typeof fetch
 * }} options
 */
export function createRemoteLlmReviewProvider({
  baseUrl,
  model,
  apiKeyEnv,
  timeoutMs: defaultTimeoutMs,
  fetchImpl = globalThis.fetch.bind(globalThis)
}) {
  const normalizedBase = String(baseUrl || '').replace(/\/+$/, '');

  /**
   * @param {{
   *   projectDir: string,
   *   promptFile: string,
   *   outputFile: string,
   *   timeoutMs?: number,
   *   signal?: AbortSignal
   * }} ctx
   */
  async function review({ promptFile, timeoutMs, signal }) {
    const started = Date.now();
    const effectiveTimeout = timeoutMs ?? defaultTimeoutMs;
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      throw new AppError(
        ErrorCodes.REMOTE_LLM_AUTH_FAILED,
        `远程大模型 API Key 环境变量未设置: ${apiKeyEnv}`
      );
    }

    const promptText = await fs.readFile(promptFile, 'utf8');
    const url = `${normalizedBase}/v1/chat/completions`;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeout);

    const onExternalAbort = () => {
      controller.abort();
    };
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    /** @type {Response} */
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: promptText }],
          temperature: 0
        }),
        signal: controller.signal
      });
    } catch (err) {
      if (timedOut || (err && /** @type {{ name?: string }} */ (err).name === 'AbortError')) {
        throw new AppError(ErrorCodes.REMOTE_LLM_TIMEOUT, '远程大模型请求超时');
      }
      throw new AppError(
        ErrorCodes.REMOTE_LLM_UNAVAILABLE,
        '远程大模型不可用'
      );
    } finally {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onExternalAbort);
      }
    }

    if (response.status === 401 || response.status === 403) {
      throw new AppError(ErrorCodes.REMOTE_LLM_AUTH_FAILED, '远程大模型鉴权失败');
    }
    if (response.status === 429) {
      throw new AppError(ErrorCodes.REMOTE_LLM_RATE_LIMITED, '远程大模型限流');
    }
    if (response.status >= 500) {
      throw new AppError(ErrorCodes.REMOTE_LLM_UNAVAILABLE, '远程大模型不可用');
    }
    if (!response.ok) {
      throw new AppError(ErrorCodes.REMOTE_LLM_UNAVAILABLE, '远程大模型不可用');
    }

    let payload;
    try {
      const text = await response.text();
      payload = JSON.parse(text);
    } catch {
      throw new AppError(
        ErrorCodes.REMOTE_LLM_INVALID_RESPONSE,
        '远程大模型响应不是合法 JSON'
      );
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new AppError(
        ErrorCodes.REMOTE_LLM_INVALID_RESPONSE,
        '远程大模型响应缺少 choices[0].message.content'
      );
    }

    return {
      rawOutput: content,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - started,
      providerMetadata: {
        model,
        baseUrl: normalizedBase
      }
    };
  }

  return { review };
}
