// Claude Messages API over plain fetch, the same path the extension uses for its
// providers (no SDK, no dependency). Request shapes follow the claude-api
// reference (checked 22 Nov 2026): API version 2026-10-21, structured outputs
// through output_config.format, thinking and effort per model, usage fields.
// The key comes only from ANTHROPIC_API_KEY and is never printed or stored.

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2026-10-21';

/**
 * What "thinking off" means per model (docs, 22 Nov 2026):
 *  - Haiku 5.5: {type:"disabled"} is accepted at effort low, medium or high.
 *  - Sonnet 5.5: "disabled" is a 400; {type:"between_tools"} is the off setting
 *    (no other field inside, effort high or below).
 *  - Opus 5.5: thinking cannot be disabled at any effort; omit it (adaptive) and
 *    use effort "low".
 * Anything else is sent as {type:"disabled"}.
 */
export function thinkingParams(model, thinking, effort) {
  if (thinking === 'adaptive') {
    return { thinking: { type: 'adaptive' }, effort: effort || undefined, note: 'adaptive thinking' };
  }
  if (/sonnet-5-5/.test(model)) {
    return { thinking: { type: 'between_tools' }, effort: effort || undefined, note: 'between_tools (Sonnet 5.5 off setting)' };
  }
  if (/opus-5-5/.test(model)) {
    return { thinking: undefined, effort: effort || 'low', note: 'Opus 5.5 cannot disable thinking: thinking omitted, effort low' };
  }
  return { thinking: { type: 'disabled' }, effort: effort || undefined, note: 'disabled' };
}

/** One streamed Messages request. Never throws for API errors: a failure is a record. */
export async function requestMessage({ model, system, user, schema, maxTokens, thinking, effort, signal }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const params = thinkingParams(model, thinking, effort);
  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema }, ...(params.effort ? { effort: params.effort } : {}) }
  };
  if (params.thinking) body.thinking = params.thinking;
  const sent = { thinking: params.thinking ?? null, effort: params.effort ?? null, note: params.note, max_tokens: maxTokens };

  const record = {
    ok: false, status: null, error: null, wall_ms: null, headers_ms: null, ttfb_ms: null, first_token_ms: null,
    stop_reason: null, input_tokens: null, output_tokens: null, thinking_tokens: null,
    cache_read_tokens: null, text: '', sent
  };
  const t0 = performance.now();
  const since = () => Math.round(performance.now() - t0);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
      body: JSON.stringify(body),
      signal
    });
    record.status = response.status;
    record.headers_ms = since();
    if (!response.ok) {
      const text = await response.text();
      record.error = text.slice(0, 600);
      record.wall_ms = since();
      return record;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const usage = {};
    const handle = event => {
      if (event.type === 'message_start') Object.assign(usage, event.message?.usage || {});
      else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        if (record.first_token_ms === null) record.first_token_ms = since();
        record.text += event.delta.text;
      } else if (event.type === 'message_delta') {
        Object.assign(usage, event.usage || {});
        if (event.delta?.stop_reason) record.stop_reason = event.delta.stop_reason;
      } else if (event.type === 'error') {
        record.error = JSON.stringify(event.error).slice(0, 600);
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (record.ttfb_ms === null) record.ttfb_ms = since();
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = chunk.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
        if (!data) continue;
        try { handle(JSON.parse(data)); } catch { /* ignore a malformed event */ }
      }
    }
    record.wall_ms = since();
    record.input_tokens = usage.input_tokens ?? null;
    record.output_tokens = usage.output_tokens ?? null;
    record.thinking_tokens = usage.output_tokens_details?.thinking_tokens ?? null;
    record.cache_read_tokens = usage.cache_read_input_tokens ?? null;
    record.usage_raw = usage;
    record.ok = !record.error && record.stop_reason === 'end_turn';
    if (!record.ok && !record.error) record.error = `stop_reason ${record.stop_reason}`;
  } catch (error) {
    record.wall_ms = since();
    record.error = String(error?.message || error).slice(0, 300);
  }
  return record;
}
