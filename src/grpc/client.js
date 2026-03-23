/**
 * gRPC streaming client for Cloud Code PredictionService
 *
 * Sends requests via gRPC (HTTP/2 + protobuf) to match the real
 * Antigravity Go binary's protocol, eliminating the biggest detection vector.
 *
 * Key differences from REST:
 * - HTTP/2 instead of HTTP/1.1
 * - Protobuf binary framing instead of JSON
 * - content-type: application/grpc instead of application/json
 * - user-agent: grpc-go/X.X.X instead of antigravity/X.X.X
 */

import * as grpc from '@grpc/grpc-js';
import { config } from '../config.js';
import { getServiceClient } from './proto-loader.js';
import { buildGrpcMetadata } from '../fingerprint/header-generator.js';

// gRPC endpoint (same host, but gRPC uses port 443 with SSL)
const GRPC_TARGET = 'cloudcode-pa.googleapis.com:443';

/**
 * Create a new gRPC client for a single request.
 * Real Go binary creates a new connection per request (Connection: close behavior).
 *
 * @param {Object} [options]
 * @param {string} [options.target] - Override gRPC target
 * @returns {Object} gRPC client instance
 */
function createClient(options = {}) {
  const ServiceClient = getServiceClient();
  const target = options.target || GRPC_TARGET;

  // Channel options to match real grpc-go client fingerprint
  const channelOptions = {
    // User-agent is set via metadata, but grpc-js also sends its own
    // We override it at the channel level
    'grpc.primary_user_agent': `grpc-go/${config.grpc.grpcGoVersion}`,
    // Disable grpc-js built-in retry (we handle retries ourselves)
    'grpc.enable_retries': 0,
    // Match grpc-go defaults
    'grpc.keepalive_time_ms': 0,           // No keepalive (one-shot)
    'grpc.keepalive_timeout_ms': 20000,
    'grpc.max_receive_message_length': 64 * 1024 * 1024,  // 64MB
    'grpc.max_send_message_length': 64 * 1024 * 1024,
    // Initial window sizes matching grpc-go defaults
    'grpc.http2.initial_window_size': 65535,
    'grpc.http2.initial_connection_window_size': 65535,
  };

  // Outbound proxy support
  if (config.outboundProxy) {
    channelOptions['grpc.http_proxy'] = config.outboundProxy;
  }

  // SSL credentials (system CA)
  const credentials = grpc.credentials.createSsl();

  const client = new ServiceClient(target, credentials, channelOptions);
  return client;
}

/**
 * Execute a streaming gRPC call to StreamGenerateContent.
 *
 * @param {Object} payload - Cloud Code request payload (JS object, same as REST JSON body)
 * @param {string} accessToken - OAuth2 bearer token
 * @param {Object} [options]
 * @param {boolean} [options.isGeminiModel] - Whether this is a Gemini model
 * @returns {Promise<{stream: grpc.ClientReadableStream, client: Object}>}
 */
export function streamGenerateContent(payload, accessToken, options = {}) {
  const client = createClient();
  const metadata = buildGrpcMetadata(accessToken, options);

  // Set deadline (10 minutes for streaming)
  const deadline = new Date();
  deadline.setMinutes(deadline.getMinutes() + 10);

  // Initiate server-streaming call
  const stream = client.StreamGenerateContent(
    payload,
    metadata,
    { deadline }
  );

  return { stream, client };
}

/**
 * Close a gRPC client and its underlying channel.
 * @param {Object} client
 */
export function closeClient(client) {
  if (client) {
    try {
      client.close();
    } catch { /* ignore */ }
  }
}

/**
 * Convert a REST-style Cloud Code payload to gRPC-compatible format.
 *
 * The REST payload uses camelCase JSON keys which map directly to proto fields.
 * However, google.protobuf.Struct fields (functionCall.args, functionResponse.response)
 * need special handling — they must be passed as plain JS objects and
 * @grpc/proto-loader will handle the Struct encoding.
 *
 * @param {Object} restPayload - The payload from buildCloudCodeRequest()
 * @returns {Object} gRPC-compatible request object
 */
export function convertPayloadForGrpc(restPayload) {
  // The payload structure is already compatible —
  // @grpc/proto-loader with keepCase:false handles the field name mapping.
  // We just need to ensure Struct fields are plain objects.

  const grpcPayload = {
    project: restPayload.project,
    model: restPayload.model,
    userAgent: restPayload.userAgent,
    requestType: restPayload.requestType,
    requestId: restPayload.requestId,
    request: convertInnerRequest(restPayload.request),
  };

  return grpcPayload;
}

/**
 * Convert inner GenerateContentRequest for gRPC
 */
function convertInnerRequest(req) {
  if (!req) return req;

  const grpcReq = { ...req };

  // Convert contents — need to handle functionCall.args (Struct type)
  if (grpcReq.contents) {
    grpcReq.contents = grpcReq.contents.map(convertContent);
  }

  // Convert systemInstruction
  if (grpcReq.systemInstruction) {
    grpcReq.systemInstruction = convertContent(grpcReq.systemInstruction);
  }

  // Convert tools — Schema fields are already plain objects
  // No special conversion needed for tools

  // Map sessionId field name
  if (grpcReq.sessionId !== undefined) {
    grpcReq.sessionId = grpcReq.sessionId;
  }

  // Convert generationConfig field names
  if (grpcReq.generationConfig) {
    grpcReq.generationConfig = convertGenerationConfig(grpcReq.generationConfig);
  }

  return grpcReq;
}

/**
 * Convert Content message for gRPC — handle Struct fields in parts
 */
function convertContent(content) {
  if (!content || !content.parts) return content;

  return {
    role: content.role,
    parts: content.parts.map(convertPart),
  };
}

/**
 * Convert Part message — functionCall.args and functionResponse.response are Struct
 */
function convertPart(part) {
  if (!part) return part;

  const converted = {};

  if (part.text !== undefined) converted.text = part.text;
  if (part.thought !== undefined) converted.thought = part.thought;
  if (part.thoughtSignature !== undefined) converted.thoughtSignature = part.thoughtSignature;

  if (part.inlineData) {
    converted.inlineData = {
      mimeType: part.inlineData.mimeType,
      data: part.inlineData.data instanceof Buffer
        ? part.inlineData.data
        : Buffer.from(part.inlineData.data, 'base64'),
    };
  }

  if (part.functionCall) {
    converted.functionCall = {
      name: part.functionCall.name,
      // args must be a plain JS object — proto-loader handles Struct encoding
      args: part.functionCall.args || {},
    };
    if (part.functionCall.id) {
      converted.functionCall.id = part.functionCall.id;
    }
  }

  if (part.functionResponse) {
    converted.functionResponse = {
      name: part.functionResponse.name,
      // response must be a plain JS object — proto-loader handles Struct encoding
      response: part.functionResponse.response || {},
    };
    if (part.functionResponse.id) {
      converted.functionResponse.id = part.functionResponse.id;
    }
  }

  return converted;
}

/**
 * Convert GenerationConfig — ensure field names match proto
 */
function convertGenerationConfig(gc) {
  const converted = {};

  if (gc.temperature !== undefined) converted.temperature = gc.temperature;
  if (gc.topP !== undefined) converted.topP = gc.topP;
  if (gc.topK !== undefined) converted.topK = gc.topK;
  if (gc.maxOutputTokens !== undefined) converted.maxOutputTokens = gc.maxOutputTokens;
  if (gc.stopSequences) converted.stopSequences = gc.stopSequences;

  if (gc.thinkingConfig) {
    converted.thinkingConfig = {
      includeThoughts: gc.thinkingConfig.include_thoughts ?? gc.thinkingConfig.includeThoughts ?? false,
      thinkingBudget: gc.thinkingConfig.thinking_budget ?? gc.thinkingConfig.thinkingBudget ?? 0,
    };
  }

  return converted;
}

/**
 * Convert a gRPC response object to the same JSON structure as REST SSE events.
 * This allows reusing the existing convertSSEEvent() pipeline.
 *
 * @param {Object} grpcResponse - Decoded protobuf response from gRPC stream
 * @returns {Object} JSON object matching REST SSE event structure
 */
export function convertGrpcResponseToJson(grpcResponse) {
  // The gRPC response is already decoded by proto-loader into a JS object
  // with camelCase field names. The structure matches the REST JSON envelope:
  // { response: { candidates: [...], usageMetadata: {...} }, traceId: "..." }

  // proto-loader returns the object in the right shape already,
  // but we need to ensure Struct fields (functionCall.args) are converted
  // back to plain objects.

  const response = grpcResponse.response || grpcResponse;

  // Deep-convert any Struct fields back to plain objects
  if (response.candidates) {
    for (const candidate of response.candidates) {
      if (candidate.content?.parts) {
        for (const part of candidate.content.parts) {
          if (part.functionCall?.args) {
            part.functionCall.args = structToObject(part.functionCall.args);
          }
          if (part.functionResponse?.response) {
            part.functionResponse.response = structToObject(part.functionResponse.response);
          }
        }
      }
    }
  }

  // Convert usageMetadata field names to match REST JSON
  if (response.usageMetadata) {
    const um = response.usageMetadata;
    response.usageMetadata = {
      promptTokenCount: um.promptTokenCount,
      candidatesTokenCount: um.candidatesTokenCount,
      totalTokenCount: um.totalTokenCount,
    };
  }

  // Return in the Cloud Code envelope format that convertSSEEvent expects
  return {
    response,
    traceId: grpcResponse.traceId || undefined,
  };
}

/**
 * Convert a protobuf Struct (as decoded by proto-loader) back to a plain JS object.
 * proto-loader decodes Struct as { fields: { key: { stringValue: "...", ... } } }
 */
function structToObject(struct) {
  if (!struct) return {};

  // If it's already a plain object (proto-loader sometimes does this), return as-is
  if (!struct.fields) return struct;

  const result = {};
  for (const [key, value] of Object.entries(struct.fields)) {
    result[key] = valueToJs(value);
  }
  return result;
}

function valueToJs(value) {
  if (!value) return null;

  if (value.nullValue !== undefined) return null;
  if (value.numberValue !== undefined) return value.numberValue;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.structValue) return structToObject(value.structValue);
  if (value.listValue) {
    return (value.listValue.values || []).map(valueToJs);
  }

  // Fallback: if proto-loader already unwrapped
  return value;
}
