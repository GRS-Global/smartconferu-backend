import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../../config/env.js';
import { DatabaseService } from '../../core/database/database.service.js';
import { aiUsage } from '../../core/database/schema/index.js';
import { AppException, ErrorCode } from '../../core/errors/app.exception.js';

export const EMBED_MODEL = 'voyage-3.5';
export const EMBED_DIMENSIONS = 1024; // vector(1024) in paper_chunks
const EMBED_BATCH = 64;

/**
 * USD per million tokens, for ai_usage.cost_usd. A cached read costs 0.1× input, a cache write
 * 1.25× (prompt caching). Check the providers' pricing pages when they change.
 */
export const PRICES: Record<string, { input: number; output: number }> = {
  [EMBED_MODEL]: { input: 0.06, output: 0 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
};

export function costOf(
  model: string,
  input: number,
  output = 0,
  cacheRead = 0,
  cacheWrite = 0,
): number {
  const p = PRICES[model] ?? { input: 0, output: 0 };
  return Number(
    (
      (input * p.input +
        output * p.output +
        cacheRead * p.input * 0.1 +
        cacheWrite * p.input * 1.25) /
      1e6
    ).toFixed(6),
  );
}

export interface UsageRow {
  userId?: string | null;
  conferenceId?: string | null;
  submissionId?: string | null;
  feature: string;
  provider?: 'anthropic' | 'voyage';
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  status?: 'ok' | 'error';
}

/** A Messages API response, from the regular or the beta endpoint. */
type AnyMessage = Anthropic.Message | Anthropic.Beta.BetaMessage;

/** The token counts of one Messages API response. */
export function usageOf(message: AnyMessage) {
  const u = message.usage;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/** The text of a response (structured output arrives as one text block of JSON). */
export function textOf(message: AnyMessage): string {
  return message.content
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('')
    .trim();
}

/**
 * The AI providers and their bookkeeping: the Claude client (one per process), Voyage embeddings,
 * ai_usage rows, and turning provider failures into API errors. The keys stay on the server.
 */
@Injectable()
export class AiCoreService {
  private readonly logger = new Logger(AiCoreService.name);
  private readonly anthropic: Anthropic | null;
  private readonly voyageKey: string | null;
  private readonly voyageUrl: string;

  constructor(
    private readonly database: DatabaseService,
    config: ConfigService<Env, true>,
  ) {
    const apiKey = config.get('ANTHROPIC_API_KEY', { infer: true });
    const workspace = config.get('ANTHROPIC_WORKSPACE_ID', { infer: true });
    this.anthropic = apiKey
      ? new Anthropic({
          apiKey,
          ...(workspace
            ? { defaultHeaders: { 'anthropic-workspace-id': workspace } }
            : {}),
        })
      : null;
    this.voyageKey = config.get('VOYAGE_API_KEY', { infer: true }) || null;
    const voyageBase = config.get('VOYAGE_BASE_URL', { infer: true });
    this.voyageUrl = `${voyageBase.replace(/\/$/, '')}/v1/embeddings`;
  }

  get canEmbed(): boolean {
    return this.voyageKey !== null;
  }

  get configured(): boolean {
    return this.anthropic !== null;
  }

  /** The Claude client; 503 when the server has no key. */
  claude(feature: string): Anthropic {
    if (!this.anthropic) {
      throw new AppException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.NOT_READY,
        `${feature} isn't set up on the server (ANTHROPIC_API_KEY is not set).`,
      );
    }
    return this.anthropic;
  }

  /** Embeddings from Voyage AI. inputType "document" for paper chunks, "query" for a question. */
  async embed(
    texts: readonly string[],
    inputType: 'document' | 'query',
  ): Promise<{ vectors: number[][]; tokens: number }> {
    if (!this.voyageKey) {
      throw new AppException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.NOT_READY,
        "Paper AI isn't set up on the server (VOYAGE_API_KEY is not set).",
      );
    }
    const vectors: number[][] = [];
    let tokens = 0;
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const res = await fetch(this.voyageUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.voyageKey}`,
        },
        body: JSON.stringify({
          input: texts.slice(i, i + EMBED_BATCH),
          model: EMBED_MODEL,
          input_type: inputType,
          output_dimension: EMBED_DIMENSIONS,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        data?: { index: number; embedding: number[] }[];
        usage?: { total_tokens?: number };
        detail?: string;
      };
      if (!res.ok || !body.data) {
        throw new AppException(
          HttpStatus.BAD_GATEWAY,
          ErrorCode.AI_FAILED,
          `Voyage AI: ${body.detail ?? `error ${res.status}`}`,
        );
      }
      for (const d of [...body.data].sort((a, b) => a.index - b.index)) {
        vectors.push(d.embedding);
      }
      tokens += body.usage?.total_tokens ?? 0;
    }
    return { vectors, tokens };
  }

  /** One ai_usage row. Never fails the request: a row that can't be written is only logged. */
  async record(row: UsageRow): Promise<void> {
    const model = row.model;
    try {
      await this.database.db.insert(aiUsage).values({
        userId: row.userId ?? null,
        conferenceId: row.conferenceId ?? null,
        submissionId: row.submissionId ?? null,
        feature: row.feature,
        provider: row.provider ?? 'anthropic',
        model,
        inputTokens: row.inputTokens ?? 0,
        outputTokens: row.outputTokens ?? 0,
        cacheReadTokens: row.cacheReadTokens ?? 0,
        cacheWriteTokens: row.cacheWriteTokens ?? 0,
        costUsd: String(
          costOf(
            model,
            row.inputTokens ?? 0,
            row.outputTokens ?? 0,
            row.cacheReadTokens ?? 0,
            row.cacheWriteTokens ?? 0,
          ),
        ),
        status: row.status ?? 'ok',
      });
    } catch (error) {
      this.logger.warn(
        { err: error, feature: row.feature },
        'ai_usage row not written',
      );
    }
  }

  /** A provider failure as an API error the app can show. */
  failure(feature: string, error: unknown): AppException {
    if (error instanceof AppException) {
      return error;
    }
    if (error instanceof Anthropic.RateLimitError) {
      return new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        ErrorCode.RATE_LIMITED,
        `${feature} is busy — try again in a moment.`,
      );
    }
    if (error instanceof Anthropic.APIError) {
      return new AppException(
        HttpStatus.BAD_GATEWAY,
        ErrorCode.AI_FAILED,
        `${feature} failed: ${error.message}`,
      );
    }
    if (error instanceof SyntaxError) {
      return new AppException(
        HttpStatus.BAD_GATEWAY,
        ErrorCode.AI_FAILED,
        `${feature}'s answer couldn't be read. Try again.`,
      );
    }
    this.logger.error({ err: error, feature }, 'AI call failed');
    return new AppException(
      HttpStatus.BAD_GATEWAY,
      ErrorCode.AI_FAILED,
      `Could not reach ${feature}.`,
    );
  }

  /** The request declined by the model (stop_reason "refusal"). */
  declined(message: string): AppException {
    return new AppException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      ErrorCode.AI_FAILED,
      message,
    );
  }
}
