/**
 * Protocol translator: Google Cloud Code SSE → Anthropic Messages API format
 * Converts streaming responses back to Anthropic format
 */

import { randomUUID } from 'crypto';

/**
 * Parse a Google Cloud Code SSE event and convert to Anthropic format
 * @param {string} data - JSON data from SSE event
 * @param {Object} state - Mutable state tracker for the stream
 * @returns {Object[]} Array of Anthropic SSE events to emit
 */
export function convertSSEEvent(data, state) {
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }

  const events = [];

  // Handle error responses
  if (parsed.error) {
    return [{
      type: 'error',
      error: {
        type: mapErrorType(parsed.error.code),
        message: parsed.error.message || 'Unknown error'
      }
    }];
  }

  // Unwrap Cloud Code envelope: {"response": {...}, "traceId": ..., "metadata": ...}
  const inner = parsed.response || parsed;

  // First event - emit message_start
  if (!state.started) {
    state.started = true;
    state.messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    state.blockIndex = 0;
    state.inputTokens = 0;
    state.outputTokens = 0;

    events.push({
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: state.model || 'unknown',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  // Process candidates
  const candidates = inner.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate.content?.parts || [];

    for (const part of parts) {
      // Thinking/thought block
      if (part.thought && part.text) {
        if (!state.inThinking) {
          state.inThinking = true;
          state.thinkingIndex = state.blockIndex++;
          events.push({
            type: 'content_block_start',
            index: state.thinkingIndex,
            content_block: { type: 'thinking', thinking: '' }
          });
        }
        events.push({
          type: 'content_block_delta',
          index: state.thinkingIndex,
          delta: { type: 'thinking_delta', thinking: part.text }
        });
      }
      // Regular text
      else if (part.text !== undefined && !part.thought) {
        // Close thinking block if open
        if (state.inThinking) {
          state.inThinking = false;
          events.push({
            type: 'content_block_stop',
            index: state.thinkingIndex
          });
        }

        if (!state.inText) {
          state.inText = true;
          state.textIndex = state.blockIndex++;
          events.push({
            type: 'content_block_start',
            index: state.textIndex,
            content_block: { type: 'text', text: '' }
          });
        }
        events.push({
          type: 'content_block_delta',
          index: state.textIndex,
          delta: { type: 'text_delta', text: part.text }
        });
      }
      // Function call (tool use)
      else if (part.functionCall) {
        // Close any open blocks
        if (state.inThinking) {
          state.inThinking = false;
          events.push({ type: 'content_block_stop', index: state.thinkingIndex });
        }
        if (state.inText) {
          state.inText = false;
          events.push({ type: 'content_block_stop', index: state.textIndex });
        }

        const toolIndex = state.blockIndex++;
        const toolId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
        events.push({
          type: 'content_block_start',
          index: toolIndex,
          content_block: {
            type: 'tool_use',
            id: toolId,
            name: part.functionCall.name,
            input: {}
          }
        });
        events.push({
          type: 'content_block_delta',
          index: toolIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(part.functionCall.args || {})
          }
        });
        events.push({ type: 'content_block_stop', index: toolIndex });
      }
    }

    // Check for finish reason
    if (candidate.finishReason) {
      state.stopReason = mapStopReason(candidate.finishReason);
    }
  }

  // Usage metadata
  if (inner.usageMetadata) {
    state.inputTokens = inner.usageMetadata.promptTokenCount || state.inputTokens;
    state.outputTokens = inner.usageMetadata.candidatesTokenCount || state.outputTokens;
  }

  return events;
}

/**
 * Generate final events to close the stream
 * @param {Object} state
 * @returns {Object[]}
 */
export function buildStreamEnd(state) {
  const events = [];

  // Close any open blocks
  if (state.inThinking) {
    events.push({ type: 'content_block_stop', index: state.thinkingIndex });
  }
  if (state.inText) {
    events.push({ type: 'content_block_stop', index: state.textIndex });
  }

  // Message delta with stop reason and final usage
  events.push({
    type: 'message_delta',
    delta: {
      stop_reason: state.stopReason || 'end_turn',
      stop_sequence: null
    },
    usage: { output_tokens: state.outputTokens }
  });

  events.push({ type: 'message_stop' });

  return events;
}

/**
 * Create initial stream state
 * @param {string} model
 * @returns {Object}
 */
export function createStreamState(model) {
  return {
    model,
    started: false,
    messageId: null,
    blockIndex: 0,
    inThinking: false,
    inText: false,
    thinkingIndex: -1,
    textIndex: -1,
    stopReason: null,
    inputTokens: 0,
    outputTokens: 0
  };
}

function mapStopReason(googleReason) {
  const map = {
    'STOP': 'end_turn',
    'MAX_TOKENS': 'max_tokens',
    'SAFETY': 'end_turn',
    'RECITATION': 'end_turn',
    'FINISH_REASON_UNSPECIFIED': 'end_turn'
  };
  return map[googleReason] || 'end_turn';
}

function mapErrorType(code) {
  if (code === 429) return 'rate_limit_error';
  if (code === 401 || code === 403) return 'authentication_error';
  if (code === 400) return 'invalid_request_error';
  if (code >= 500) return 'api_error';
  return 'api_error';
}
