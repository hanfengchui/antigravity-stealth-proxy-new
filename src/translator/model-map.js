/**
 * Model mapping - maps Claude Code CLI model names to Cloud Code API model names
 *
 * Key discovery: Cloud Code API has different UA requirements per model family:
 * - Claude models REQUIRE antigravity UA (vscode UA → 404)
 * - Gemini models REQUIRE vscode UA (antigravity UA → 404)
 */

// Claude Code CLI model names → Cloud Code API model names
// Available Claude models (from fetchAvailableModels): claude-opus-4-6-thinking, claude-sonnet-4-6
const CLAUDE_MODEL_MAP = {
  // Claude Code CLI sends these names
  'claude-opus-4-6': 'claude-opus-4-6-thinking',       // opus 映射到 thinking 版本
  'claude-opus-4-6-thinking': 'claude-opus-4-6-thinking',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6',   // sonnet thinking 映射到 sonnet-4-6（本身支持thinking）
  'claude-sonnet-4-5': 'claude-sonnet-4-6',
  'claude-sonnet-4-5-thinking': 'claude-sonnet-4-6',
  'claude-haiku-4-5': 'claude-sonnet-4-6',             // haiku 降级到 sonnet
  'claude-3-7-sonnet': 'claude-sonnet-4-6',
  'claude-3-5-sonnet': 'claude-sonnet-4-6',
};

// Gemini model names
const GEMINI_MODEL_MAP = {
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-2.0-flash': 'gemini-2.0-flash',
  'gemini-2.5-flash-thinking': 'gemini-2.5-flash-thinking',
  'gemini-3.1-pro-high': 'gemini-3.1-pro-high',
  'gemini-3-flash': 'gemini-3-flash',
  'gemini-3-pro-high': 'gemini-3-pro-high',
  'gemini-3-pro-low': 'gemini-3-pro-low',
};

// Fallback: when Claude models aren't available (standard-tier), map to Gemini
const CLAUDE_TO_GEMINI_FALLBACK = {
  'claude-opus-4-6-thinking': 'gemini-2.5-pro',
  'claude-opus-4-6': 'gemini-2.5-pro',
  'claude-sonnet-4-6-thinking': 'gemini-2.5-pro',
  'claude-sonnet-4-6': 'gemini-2.5-pro',
  'claude-sonnet-4-5-thinking': 'gemini-2.5-pro',
  'claude-sonnet-4-5': 'gemini-2.5-pro',
  'claude-haiku-4-5': 'gemini-2.5-flash',
  'claude-3-7-sonnet': 'gemini-2.5-pro',
  'claude-3-5-sonnet': 'gemini-2.5-flash',
};

/**
 * Resolve a model name from Claude Code CLI to the actual Cloud Code API model name
 * @param {string} requestedModel - Model name from the client request
 * @param {string} tier - Account tier (e.g., 'standard-tier', 'g1-ultra-tier')
 * @returns {{ model: string, isClaudeModel: boolean, isFallback: boolean, originalModel: string }}
 */
export function resolveModel(requestedModel, tier = 'standard-tier') {
  const normalized = requestedModel.toLowerCase().trim();
  // Claude models are available if fetchAvailableModels returned them
  // Tier check is a fallback heuristic
  const hasClaude = tier === 'g1-ultra-tier' || tier === 'g1-pro-tier' || tier === 'standard-tier';

  // Direct Gemini model
  if (GEMINI_MODEL_MAP[normalized]) {
    return {
      model: GEMINI_MODEL_MAP[normalized],
      isClaudeModel: false,
      isFallback: false,
      originalModel: requestedModel
    };
  }

  // Claude model - try direct mapping first
  if (CLAUDE_MODEL_MAP[normalized]) {
    return {
      model: CLAUDE_MODEL_MAP[normalized],
      isClaudeModel: true,
      isFallback: false,
      originalModel: requestedModel
    };
  }

  // Unknown model - pass through as-is
  return {
    model: requestedModel,
    isClaudeModel: normalized.includes('claude'),
    isFallback: false,
    originalModel: requestedModel
  };
}

/**
 * Check if a model name implies thinking/extended reasoning
 * @param {string} model
 * @returns {boolean}
 */
export function isThinkingModel(model) {
  const lower = model.toLowerCase();
  return lower.includes('thinking') || lower === 'gemini-2.5-pro' || lower === 'gemini-2.5-flash';
}

/**
 * Get the list of models to advertise to Claude Code CLI
 * @returns {Array}
 */
export function getAdvertisedModels() {
  // Use fixed timestamps (matching real Anthropic API behavior — model creation dates don't change)
  return [
    { id: 'claude-sonnet-4-6-thinking', object: 'model', created: 1748476800 },
    { id: 'claude-opus-4-6-thinking', object: 'model', created: 1748476800 },
    { id: 'claude-sonnet-4-6', object: 'model', created: 1748476800 },
    { id: 'claude-opus-4-6', object: 'model', created: 1748476800 },
    { id: 'claude-haiku-4-5', object: 'model', created: 1746057600 },
    { id: 'gemini-2.5-pro', object: 'model', created: 1743638400 },
    { id: 'gemini-2.5-flash', object: 'model', created: 1743638400 },
    { id: 'gemini-2.0-flash', object: 'model', created: 1739404800 },
  ];
}
