/**
 * Protocol translator: Anthropic Messages API → Google Cloud Code API
 * Matches the actual Cloud Code v1internal payload structure
 */

import { randomUUID } from 'crypto';
// Header generation is handled by buildHeaders() — request.js only builds the payload body

// No hardcoded system instruction — pass through whatever the client sends.
// Adding a static prefix is a detection vector (every request from this proxy
// would share the same fingerprint in the system prompt).

/**
 * Convert Anthropic Messages request to Cloud Code API payload
 * Structure: { project, model, request: {googleRequest}, userAgent, requestType, requestId }
 */
export function buildCloudCodeRequest(anthropicReq, projectId, sessionKey, sessionId) {
  const model = anthropicReq.model || 'claude-sonnet-4-6-thinking';
  const isClaudeModel = model.toLowerCase().includes('claude');
  const isThinking = model.toLowerCase().includes('thinking') || model.toLowerCase().includes('gemini-2.5');

  // Build the inner Google Generative AI request
  const googleRequest = {
    contents: convertMessages(anthropicReq.messages || [], isClaudeModel),
    generationConfig: buildGenerationConfig(anthropicReq, isClaudeModel, isThinking),
    sessionId
  };

  // System instruction
  googleRequest.systemInstruction = buildSystemInstruction(anthropicReq.system);

  // Tools
  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    googleRequest.tools = convertTools(anthropicReq.tools);
    if (isClaudeModel) {
      googleRequest.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } };
    }
  }

  // Wrap in Cloud Code envelope
  // userAgent in envelope must match the HTTP User-Agent header model family
  return {
    project: projectId,
    model,
    request: googleRequest,
    userAgent: isClaudeModel ? 'antigravity' : 'vscode',
    requestType: 'agent',
    requestId: `agent-${randomUUID()}`
  };
}

/**
 * Convert Anthropic messages to Google contents format
 */
function convertMessages(messages, isClaudeModel) {
  const contents = [];

  for (const msg of messages) {
    const role = (msg.role === 'assistant' || msg.role === 'model') ? 'model' : 'user';
    const parts = [];

    if (typeof msg.content === 'string') {
      if (msg.content.trim()) parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block) continue;

        // Strip cache_control from all blocks (Cloud Code rejects it)
        const { cache_control, ...cleanBlock } = block;

        if (cleanBlock.type === 'text') {
          if (cleanBlock.text && cleanBlock.text.trim()) {
            parts.push({ text: cleanBlock.text });
          }
        } else if (cleanBlock.type === 'thinking') {
          if (cleanBlock.thinking && cleanBlock.signature && cleanBlock.signature.length >= 50) {
            parts.push({
              text: cleanBlock.thinking,
              thought: true,
              thoughtSignature: cleanBlock.signature
            });
          }
          // Drop unsigned thinking blocks
        } else if (cleanBlock.type === 'redacted_thinking') {
          // Explicitly skip - Google API doesn't support redacted thinking
          continue;
        } else if (cleanBlock.type === 'tool_use') {
          const fc = {
            name: cleanBlock.name,
            args: cleanBlock.input || {}
          };
          if (isClaudeModel && cleanBlock.id) {
            fc.id = cleanBlock.id;
          }
          parts.push({ functionCall: fc });
        } else if (cleanBlock.type === 'tool_result') {
          let responseContent;
          if (typeof cleanBlock.content === 'string') {
            responseContent = { result: cleanBlock.content };
          } else if (Array.isArray(cleanBlock.content)) {
            const texts = cleanBlock.content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('\n');
            responseContent = { result: texts || '' };
          } else {
            responseContent = { result: String(cleanBlock.content || '') };
          }

          const fr = {
            name: cleanBlock.tool_use_id || 'unknown',
            response: responseContent
          };
          if (isClaudeModel && cleanBlock.tool_use_id) {
            fr.id = cleanBlock.tool_use_id;
          }
          parts.push({ functionResponse: fr });
        } else if (cleanBlock.type === 'image' && cleanBlock.source?.type === 'base64') {
          parts.push({
            inlineData: {
              mimeType: cleanBlock.source.media_type,
              data: cleanBlock.source.data
            }
          });
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    } else {
      // Safety: API requires at least one part per content
      contents.push({ role, parts: [{ text: '.' }] });
    }
  }

  return contents;
}

/**
 * Build system instruction — pass through client's system prompt as-is
 */
function buildSystemInstruction(systemPrompt) {
  if (!systemPrompt) return undefined;

  const parts = [];

  if (typeof systemPrompt === 'string') {
    if (systemPrompt.trim()) parts.push({ text: systemPrompt });
  } else if (Array.isArray(systemPrompt)) {
    const text = systemPrompt
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
    if (text.trim()) parts.push({ text });
  }

  return parts.length > 0 ? { role: 'user', parts } : undefined;
}

/**
 * Build generation config with correct field names per model family
 */
function buildGenerationConfig(anthropicReq, isClaudeModel, isThinking) {
  const gc = {};

  if (anthropicReq.max_tokens) {
    gc.maxOutputTokens = anthropicReq.max_tokens;
  }
  if (anthropicReq.temperature !== undefined) {
    gc.temperature = anthropicReq.temperature;
  }
  if (anthropicReq.top_p !== undefined) {
    gc.topP = anthropicReq.top_p;
  }
  if (anthropicReq.top_k !== undefined) {
    gc.topK = anthropicReq.top_k;
  }
  if (anthropicReq.stop_sequences) {
    gc.stopSequences = anthropicReq.stop_sequences;
  }

  // Thinking config
  if (isThinking) {
    if (isClaudeModel) {
      // Claude uses snake_case for thinking config
      const budget = anthropicReq.thinking?.budget_tokens || 32000;
      gc.thinkingConfig = {
        include_thoughts: true,
        thinking_budget: budget
      };
      // Ensure max_tokens > thinking_budget
      if (gc.maxOutputTokens && gc.maxOutputTokens <= budget) {
        gc.maxOutputTokens = budget + 8192;
      }
    } else {
      // Gemini uses camelCase
      const budget = anthropicReq.thinking?.budget_tokens || 24576;
      gc.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: budget
      };
      // Gemini thinking models need sufficient output tokens
      if (!gc.maxOutputTokens || gc.maxOutputTokens < budget + 4096) {
        gc.maxOutputTokens = budget + 8192;
      }
    }
  }

  return gc;
}

/**
 * Convert Anthropic tools to Google function declarations
 */
function convertTools(tools) {
  const functionDeclarations = tools.map((tool, idx) => {
    const name = String(tool.name || `tool-${idx}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const schema = tool.input_schema || tool.parameters || { type: 'object' };

    // Clean schema: remove unsupported fields
    const cleanedSchema = cleanSchema(schema);

    return {
      name,
      description: tool.description || '',
      parameters: cleanedSchema
    };
  });

  return [{ functionDeclarations }];
}

/**
 * Whitelist of JSON Schema fields supported by Google's protobuf Schema.
 * Source: google/ai/generativelanguage/v1beta/content.proto (22 fields)
 */
const SUPPORTED_SCHEMA_KEYS = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum',
  'items', 'maxItems', 'minItems', 'properties', 'required',
  'minProperties', 'maxProperties', 'minimum', 'maximum',
  'minLength', 'maxLength', 'pattern', 'example', 'anyOf',
  'propertyOrdering', 'default'
]);

/**
 * Clean JSON schema for Cloud Code compatibility
 * Only keeps fields in the protobuf-supported whitelist
 */
function cleanSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;

  const cleaned = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) continue;

    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        cleaned[key] = value.map(v => typeof v === 'object' ? cleanSchema(v) : v);
      } else {
        cleaned[key] = cleanSchema(value);
      }
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}
