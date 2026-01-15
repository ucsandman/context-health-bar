/**
 * Context Health Bar for Claude
 *
 * Visualizes LLM context degradation as a video game-style health bar.
 * This is a heuristic system that estimates when Claude's performance
 * may degrade due to long context and instruction drift.
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Token estimation: chars / 4 is rough approximation
  CHARS_PER_TOKEN: 4,

  // Health calculation thresholds
  TOKEN_THRESHOLDS: {
    HIGH: 40000,      // 30 point penalty
    MEDIUM: 25000,    // 20 point penalty
    LOW: 15000        // 10 point penalty
  },
  CHAR_PENALTY_POINTS: [
    { chars: 0, penalty: 0 },
    { chars: 120000, penalty: 25 },
    { chars: 240000, penalty: 50 },
    { chars: 800000, penalty: 100 }
  ],
  MESSAGE_THRESHOLDS: {
    HIGH: 140,        // 30 point penalty
    MEDIUM: 100,      // 20 point penalty
    LOW: 60           // 10 point penalty
  },

  // Noise detection
  LONG_MESSAGE_THRESHOLD: 4000,  // chars
  ASSISTANT_DOMINANCE_RATIO: 0.7,

  // Instruction detection
  IMPERATIVE_PHRASES: [
    'you are', 'act as', 'always', 'never', 'do not', "don't",
    'must', 'should', 'follow these', 'remember to', 'make sure'
  ],
  MIN_IMPERATIVES: 2,
  EARLY_MESSAGE_COUNT: 3,

  // Update behavior
  DEBOUNCE_MS: 500,

  // Storage keys
  STORAGE_KEY: 'claude_healthbar_pins',
  HANDOFF_STORAGE_KEY: 'claude_healthbar_handoff',
  SETTINGS_KEY: 'claude_healthbar_settings',

  // Handoff behavior
  HANDOFF_THRESHOLD: 50,
  HANDOFF_EXPIRY_MS: 2 * 60 * 60 * 1000,
  HANDOFF_MAX_MESSAGE_CHARS: 900,
  HANDOFF_MAX_PINNED: 8,
  HANDOFF_MAX_RECENT: 12,
  HANDOFF_MAX_SALIENCE: 6,

  // Auto-load history for long threads
  AUTO_LOAD_HISTORY: true,
  AUTO_LOAD_INTERVAL_MS: 400,
  AUTO_LOAD_MAX_MS: 12000,
  AUTO_LOAD_IDLE_TICKS: 6
};

// ============================================================================
// STATE
// ============================================================================

let state = {
  conversationId: null,
  messages: [],
  pinnedMessageIds: new Set(),
  currentHealth: 100,
  lastTier: 'stable',
  updateTimer: null,
  inputElement: null,
  handoffApplied: false,
  autoLoadInProgress: false,
  autoLoadComplete: false,
  handoffApplyTimer: null,
  settings: null
};

// ============================================================================
// CONVERSATION PARSER
// ============================================================================

/**
 * Parse the conversation from Claude's DOM
 * Returns array of message objects with role, text, tokens, position
 */
function parseConversation() {
  const messages = [];
  let cumulativeTokens = 0;
  const messageCounts = new Map();
  let migratedLegacyPins = false;
  let totalCharsFromMessages = 0;

  // Find all message elements in Claude's conversation
  // Claude uses specific class patterns for messages
  const messageElements = document.querySelectorAll('[data-testid^="user-message"], [data-testid^="assistant-message"]');

  messageElements.forEach((element, index) => {
    // Determine role from data-testid attribute
    const testId = element.getAttribute('data-testid') || '';
    const role = testId.includes('user') ? 'user' : 'assistant';

    // Extract text content
    const textContent = extractTextContent(element);

    if (textContent.trim().length === 0) return; // Skip empty messages

    // Calculate tokens
    const charCount = textContent.length;
    totalCharsFromMessages += charCount;
    const tokens = Math.ceil(charCount / CONFIG.CHARS_PER_TOKEN);

    const textHash = hashText(textContent);
    const key = `${role}:${textHash}`;
    const occurrence = (messageCounts.get(key) || 0) + 1;
    messageCounts.set(key, occurrence);
    const messageId = `msg_${role}_${textHash}_${occurrence}`;
    element.dataset.healthbarId = messageId;
    const legacyId = `msg_${index}`;
    if (state.pinnedMessageIds.has(legacyId)) {
      state.pinnedMessageIds.delete(legacyId);
      state.pinnedMessageIds.add(messageId);
      migratedLegacyPins = true;
    }

    messages.push({
      id: messageId,
      role,
      text: textContent,
      charCount,
      tokens,
      tokenStart: cumulativeTokens,
      tokenEnd: cumulativeTokens + tokens,
      element // Store reference for pin icon injection
    });

    cumulativeTokens += tokens;
  });
  if (migratedLegacyPins) {
    savePinsToStorage();
  }

  // Include current draft input
  const draftInput = getDraftInput();
  if (draftInput && draftInput.trim().length > 0) {
    const tokens = Math.ceil(draftInput.length / CONFIG.CHARS_PER_TOKEN);
    messages.push({
      id: 'draft',
      role: 'user',
      text: draftInput,
      charCount: draftInput.length,
      tokens,
      tokenStart: cumulativeTokens,
      tokenEnd: cumulativeTokens + tokens,
      isDraft: true
    });
    cumulativeTokens += tokens;
  }

  const visibleChars = getVisibleConversationCharCount(messageElements);
  return { messages, totalTokens: cumulativeTokens, totalCharsFromMessages, visibleChars };
}

/**
 * Extract clean text content from a message element
 */
function extractTextContent(element) {
  // Clone to avoid modifying original
  const clone = element.cloneNode(true);

  // Remove any UI elements (buttons, icons, etc)
  const uiElements = clone.querySelectorAll('button, svg, [role="button"]');
  uiElements.forEach(el => el.remove());

  return clone.textContent || '';
}

/**
 * Create a stable-ish hash for message IDs
 */
function hashText(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Get current draft input from textarea
 */
function getDraftInput() {
  // Claude's input is typically in a contenteditable div or textarea
  const input = document.querySelector('[contenteditable="true"]') ||
                document.querySelector('textarea[placeholder*="Reply"]');

  return input ? input.textContent || input.value || '' : '';
}

/**
 * Estimate visible conversation char count from larger containers
 */
function getVisibleConversationCharCount(messageElements) {
  const elements = Array.from(messageElements || []);
  const container = findCommonAncestor(elements);
  if (container) {
    return (container.textContent || '').length;
  }

  const main = document.querySelector('main') || document.querySelector('[role="main"]');
  if (main) return (main.textContent || '').length;
  const root = document.querySelector('.root');
  if (root) return (root.textContent || '').length;

  return 0;
}

function findCommonAncestor(elements) {
  if (!elements || elements.length === 0) return null;
  const firstAncestors = getAncestors(elements[0]);
  for (const ancestor of firstAncestors) {
    const isCommon = elements.every(el => ancestor.contains(el));
    if (isCommon) return ancestor;
  }
  return null;
}

function getAncestors(node) {
  const ancestors = [];
  let current = node;
  while (current) {
    ancestors.push(current);
    current = current.parentElement;
  }
  return ancestors;
}

// ============================================================================
// INSTRUCTION DETECTION
// ============================================================================

/**
 * Detect which messages contain core instructions
 * Returns array of instruction message indices
 */
function detectInstructions(messages) {
  const instructions = [];

  messages.forEach((msg, index) => {
    if (msg.role !== 'user') return;
    if (msg.isDraft) return; // Don't count draft as instruction yet

    // Check if manually pinned
    if (state.pinnedMessageIds.has(msg.id)) {
      instructions.push(index);
      return;
    }

    // Automatic detection heuristics
    let isInstruction = false;

    // 1. Imperative phrase matching
    const imperativeCount = countImperativePhrases(msg.text);
    if (imperativeCount >= CONFIG.MIN_IMPERATIVES) {
      isInstruction = true;
    }

    // 2. Early conversation bias + bullet lists
    const userMessageIndex = messages.filter((m, i) => i <= index && m.role === 'user').length;
    if (userMessageIndex <= CONFIG.EARLY_MESSAGE_COUNT) {
      if (hasBulletList(msg.text)) {
        isInstruction = true;
      }
    }

    // 3. High imperative density in short messages
    if (imperativeCount >= CONFIG.MIN_IMPERATIVES && msg.charCount < 800) {
      isInstruction = true;
    }

    if (isInstruction) {
      instructions.push(index);
    }
  });

  return instructions;
}

/**
 * Count imperative phrases in text
 */
function countImperativePhrases(text) {
  const lowerText = text.toLowerCase();
  return CONFIG.IMPERATIVE_PHRASES.filter(phrase => lowerText.includes(phrase)).length;
}

/**
 * Check if text contains bullet list patterns
 */
function hasBulletList(text) {
  const bulletPatterns = [/^[\s]*[-*]\s+/m, /^[\s]*\d+\.\s+/m];
  return bulletPatterns.some(pattern => pattern.test(text));
}

// ============================================================================
// NOISE DETECTION
// ============================================================================

/**
 * Detect noise patterns that correlate with degradation
 */
function detectNoise(messages, totalTokens) {
  let noisePenalty = 0;

  // Count assistant vs user tokens
  let assistantTokens = 0;
  let longMonologueCount = 0;

  messages.forEach(msg => {
    if (msg.role === 'assistant') {
      assistantTokens += msg.tokens;

      // Check for long monologues
      if (msg.charCount > CONFIG.LONG_MESSAGE_THRESHOLD) {
        longMonologueCount++;
      }
    }
  });

  // Penalty for long assistant monologues
  if (longMonologueCount > 0) {
    noisePenalty += 10;
  }

  // Penalty for assistant dominance
  const assistantRatio = assistantTokens / totalTokens;
  if (assistantRatio > CONFIG.ASSISTANT_DOMINANCE_RATIO) {
    noisePenalty += 15;
  }

  return noisePenalty;
}

// ============================================================================
// HEALTH CALCULATION
// ============================================================================

/**
 * Calculate health score (0-100)
 * Returns { health, tier, reasons }
 */
function calculateHealth(messages, totalTokens, instructionIndices, totalCharsOverride) {
  let health = 100;
  const reasons = [];
  const hasUserMessages = messages.some(msg => msg.role === 'user' && !msg.isDraft);
  const nonDraftMessages = messages.filter(msg => !msg.isDraft);
  const messageCount = nonDraftMessages.length;
  const totalCharsFromMessages = nonDraftMessages.reduce((sum, msg) => sum + msg.charCount, 0);
  const totalChars = Math.max(totalCharsFromMessages, totalCharsOverride || 0);
  const effectiveTokens = totalTokens;
  const effectiveChars = totalChars;
  const effectiveMessages = messageCount;

  // 1. Instruction distance penalty (primary factor)
  // UPDATED: Threshold-based approach with grace period for natural conversation
  let instructionPenalty = 0;
  if (instructionIndices.length > 0) {
    // Get position of last instruction
    const lastInstructionIndex = Math.max(...instructionIndices);
    const lastInstructionMsg = messages[lastInstructionIndex];
    const lastInstructionPos = lastInstructionMsg.tokenEnd;

    const distanceFromEnd = totalTokens - lastInstructionPos;
    const distanceRatio = distanceFromEnd / totalTokens;

    // Only penalize if >50% of conversation is after last instruction
    // This gives early conversation room to breathe while catching genuine drift
    if (distanceRatio > 0.5) {
      instructionPenalty = (distanceRatio - 0.5) * 80; // 0-40 points
    }

    if (distanceFromEnd > 5000) {
      reasons.push(`Primary instruction ${Math.floor(distanceFromEnd / 1000)}k tokens back`);
    }
  } else if (hasUserMessages) {
    // No instructions detected at all
    const maxPenalty = 30;
    const rampChars = 120000;
    const scaledPenalty = (totalChars / rampChars) * maxPenalty;
    instructionPenalty = Math.min(maxPenalty, scaledPenalty);
    reasons.push('No core instructions detected');
  }

  // 2. Length penalties (token/char/message count)
  let tokenPenalty = 0;
  let charPenalty = 0;
  let messagePenalty = 0;
  if (effectiveTokens > CONFIG.TOKEN_THRESHOLDS.HIGH) {
    tokenPenalty = 30;
  } else if (effectiveTokens > CONFIG.TOKEN_THRESHOLDS.MEDIUM) {
    tokenPenalty = 20;
  } else if (effectiveTokens > CONFIG.TOKEN_THRESHOLDS.LOW) {
    tokenPenalty = 10;
  }

  charPenalty = interpolatePenalty(CONFIG.CHAR_PENALTY_POINTS, effectiveChars);

  if (effectiveMessages > CONFIG.MESSAGE_THRESHOLDS.HIGH) {
    messagePenalty = 30;
  } else if (effectiveMessages > CONFIG.MESSAGE_THRESHOLDS.MEDIUM) {
    messagePenalty = 20;
  } else if (effectiveMessages > CONFIG.MESSAGE_THRESHOLDS.LOW) {
    messagePenalty = 10;
  }

  const lengthPenalty = Math.max(tokenPenalty, charPenalty, messagePenalty);
  if (lengthPenalty === tokenPenalty && tokenPenalty > 0) {
    reasons.push(`Conversation length: ${formatCount(totalTokens)} tokens`);
  }
  if (lengthPenalty === charPenalty && charPenalty > 0) {
    reasons.push(`Conversation length: ${formatCount(totalChars)} chars`);
  }
  if (lengthPenalty === messagePenalty && messagePenalty > 0) {
    reasons.push(`Conversation length: ${messageCount} messages`);
  }

  // 3. Noise penalties
  const noisePenalty = detectNoise(messages, totalTokens);
  if (noisePenalty > 0) {
    reasons.push('Long assistant responses detected');
  }

  // Calculate final health
  health = 100 - instructionPenalty - lengthPenalty - noisePenalty;
  health = Math.max(0, Math.min(100, health));

  // Determine tier
  let tier;
  if (health >= 80) tier = 'stable';
  else if (health >= 50) tier = 'degrading';
  else if (health >= 20) tier = 'unreliable';
  else tier = 'critical';

  return {
    health: Math.round(health),
    tier,
    reasons,
    hasUserMessages,
    debugStats: {
      totalChars,
      totalTokens: Math.max(totalTokens, Math.ceil(totalChars / CONFIG.CHARS_PER_TOKEN)),
      messageCount
    }
  };
}

function formatCount(value) {
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(2)}M`;
  }
  if (value >= 1000) {
    return `${Math.round(value / 1000)}k`;
  }
  return `${value}`;
}

function interpolatePenalty(points, value) {
  if (!points || points.length === 0) return 0;
  if (value <= points[0].chars) return points[0].penalty;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const next = points[i];
    if (value <= next.chars) {
      const span = next.chars - prev.chars;
      if (span <= 0) return next.penalty;
      const ratio = (value - prev.chars) / span;
      return prev.penalty + ratio * (next.penalty - prev.penalty);
    }
  }

  return points[points.length - 1].penalty;
}

// ============================================================================
// HUD RENDERING
// ============================================================================

/**
 * Create or update the health bar HUD
 */
function renderHUD(healthData) {
  let hud = document.getElementById('claude-health-bar-hud');

  if (!hud) {
    hud = createHUD();
  }

  updateHUD(hud, healthData);

  // Check for tier change and animate
  if (healthData.tier !== state.lastTier) {
    animateTierChange(hud);
    state.lastTier = healthData.tier;
  }
}

/**
 * Create the HUD element
 */
function createHUD() {
  const hud = document.createElement('div');
  hud.id = 'claude-health-bar-hud';
  hud.className = 'health-orb';

  hud.innerHTML = `
    <div class="health-orb-value"></div>
    <div class="health-orb-panel">
      <div class="health-orb-title">Context Health</div>
      <div class="health-orb-stats"></div>
      <div class="health-bar-actions">
        <button class="health-bar-refresh" type="button">Refresh Context</button>
        <button class="health-bar-copy" type="button">Copy Handoff</button>
      </div>
      <div class="health-bar-settings">
        <label class="health-bar-setting">
          <input type="checkbox" data-setting="autoLoadHistory">
          Auto-load history
        </label>
        <label class="health-bar-setting">
          Handoff detail
          <select data-setting="handoffRichness">
            <option value="compact">Compact</option>
            <option value="standard">Standard</option>
            <option value="rich">Rich</option>
          </select>
        </label>
      </div>
    </div>
  `;

  document.body.appendChild(hud);
  initSettingsUI(hud);
  return hud;
}

/**
 * Update HUD with new health data
 */
function updateHUD(hud, healthData) {
  const percentage = hud.querySelector('.health-orb-value');
  const stats = hud.querySelector('.health-orb-stats');
  const refreshButton = hud.querySelector('.health-bar-refresh');
  const copyButton = hud.querySelector('.health-bar-copy');

  // Update orb color
  hud.className = `health-orb tier-${healthData.tier}`;

  // Update percentage
  percentage.textContent = `${healthData.health}%`;

  if (healthData.debugStats) {
    stats.textContent = `${formatCount(healthData.debugStats.totalChars)} chars | ` +
      `${formatCount(healthData.debugStats.totalTokens)} tokens | ` +
      `${healthData.debugStats.messageCount} messages`;
  } else {
    stats.textContent = '';
  }

  state.currentHealth = healthData.health;
  const canRefresh = healthData.hasUserMessages && healthData.health <= CONFIG.HANDOFF_THRESHOLD;
  refreshButton.style.display = canRefresh ? 'inline-block' : 'none';
  copyButton.style.display = healthData.hasUserMessages ? 'inline-block' : 'none';
  if (!refreshButton.dataset.bound) {
    refreshButton.addEventListener('click', () => {
      startHandoff();
    });
    refreshButton.dataset.bound = 'true';
  }
  if (!copyButton.dataset.bound) {
    copyButton.addEventListener('click', () => {
      copyHandoffToClipboard(copyButton);
    });
    copyButton.dataset.bound = 'true';
  }
}

/**
 * Animate tier change
 */
function animateTierChange(hud) {
  hud.classList.add('tier-change-pulse');
  setTimeout(() => {
    hud.classList.remove('tier-change-pulse');
  }, 500);
}

// ============================================================================
// PIN MANAGEMENT
// ============================================================================

/**
 * Inject pin icons next to user messages
 */
function injectPinIcons() {
  const messageElements = document.querySelectorAll('[data-testid^="user-message"]');

  messageElements.forEach((element) => {
    // Check if pin icon already exists
    if (element.querySelector('.health-bar-pin-icon')) return;

    const messageId = element.dataset.healthbarId;
    if (!messageId) return;
    const isPinned = state.pinnedMessageIds.has(messageId);

    // Create pin icon
    const pinIcon = document.createElement('button');
    pinIcon.className = `health-bar-pin-icon ${isPinned ? 'pinned' : ''}`;
    pinIcon.innerHTML = '📌';
    pinIcon.title = isPinned ? 'Unpin instruction' : 'Pin as core instruction';

    pinIcon.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePin(messageId);
    });

    // Inject into message (position relative to message container)
    element.style.position = 'relative';
    element.appendChild(pinIcon);
  });
}

/**
 * Toggle pin state for a message
 */
function togglePin(messageId) {
  if (state.pinnedMessageIds.has(messageId)) {
    state.pinnedMessageIds.delete(messageId);
  } else {
    state.pinnedMessageIds.add(messageId);
  }

  savePinsToStorage();
  updateHealthBar(); // Recalculate immediately

  // Update pin icon appearance
  injectPinIcons();
}

/**
 * Save pinned messages to localStorage
 */
function savePinsToStorage() {
  try {
    const data = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY) || '{}');
    data[state.conversationId] = Array.from(state.pinnedMessageIds);
    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.error('Failed to save pins:', e);
  }
}

/**
 * Load pinned messages from localStorage
 */
function loadPinsFromStorage() {
  try {
    const data = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY) || '{}');
    const pins = data[state.conversationId] || [];
    state.pinnedMessageIds = new Set(pins);
  } catch (e) {
    console.error('Failed to load pins:', e);
    state.pinnedMessageIds = new Set();
  }
}

// ============================================================================
// HANDOFF MANAGEMENT
// ============================================================================

function normalizeText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function clipText(text, maxChars) {
  const normalized = normalizeText(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function buildHandoffPacket(messages) {
  const fullMessages = messages.filter(msg => !msg.isDraft);
  const userMessages = fullMessages.filter(msg => msg.role === 'user');
  const pinnedMessages = fullMessages.filter(msg => state.pinnedMessageIds.has(msg.id));
  const limits = getHandoffLimits(state.settings);
  const recentMessages = fullMessages.slice(-limits.maxRecent);
  const recentIds = new Set(recentMessages.map(msg => msg.id));

  const lines = [];
  lines.push('# Context handoff from previous chat');
  lines.push('');

  const firstUser = userMessages[0];
  if (firstUser) {
    lines.push('## Original request:');
    lines.push(clipText(firstUser.text, limits.maxChars));
  }

  if (pinnedMessages.length > 0) {
    lines.push('');
    lines.push('### Pinned instructions:');
    pinnedMessages.slice(0, limits.maxPinned).forEach(msg => {
      lines.push(`- **User:** ${clipText(msg.text, limits.maxChars)}`);
    });
  }

  const salientMessages = getSalientMessages(fullMessages, recentIds, limits.maxSalience);
  if (salientMessages.length > 0) {
    lines.push('');
    lines.push('### Key highlights:');
    salientMessages.forEach(msg => {
      const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
      lines.push(`- **${roleLabel}:** ${clipText(msg.text, limits.maxChars)}`);
    });
  }

  const lastUser = userMessages[userMessages.length - 1];
  if (lastUser) {
    lines.push('');
    lines.push('### Current focus:');
    lines.push(clipText(lastUser.text, limits.maxChars));
  }

  if (recentMessages.length > 0) {
    lines.push('');
    lines.push('### Recent exchange:');
    recentMessages.forEach(msg => {
      const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
      lines.push(`- **${roleLabel}:** ${clipText(msg.text, limits.maxChars)}`);
    });
  }

  lines.push('');
  lines.push('Please continue from this context.');
  return lines.join('\n');
}

function getSalientMessages(messages, excludeIds, maxCount) {
  const scored = [];
  messages.forEach((msg, index) => {
    if (excludeIds.has(msg.id)) return;
    const score = scoreSalience(msg);
    if (score <= 0) return;
    scored.push({ msg, score, index });
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  return scored.slice(0, maxCount).map(item => item.msg);
}

function scoreSalience(msg) {
  let score = 0;
  if (msg.role === 'user') score += 1;
  if (hasBulletList(msg.text)) score += 3;
  if (countImperativePhrases(msg.text) >= CONFIG.MIN_IMPERATIVES) score += 2;
  if (msg.charCount > 1200) score += 2;
  if (msg.text.includes('```')) score += 2;
  if (/\bimportant\b|\bmust\b|\bshould\b|\bremember\b/i.test(msg.text)) score += 2;
  return score;
}

// ============================================================================
// SETTINGS
// ============================================================================

function getDefaultSettings() {
  return {
    autoLoadHistory: true,
    handoffRichness: 'rich'
  };
}

function getHandoffLimits(settings) {
  const richness = settings?.handoffRichness || 'rich';
  if (richness === 'compact') {
    return {
      maxChars: 400,
      maxPinned: 5,
      maxRecent: 6,
      maxSalience: 3
    };
  }
  if (richness === 'standard') {
    return {
      maxChars: 700,
      maxPinned: 6,
      maxRecent: 8,
      maxSalience: 4
    };
  }
  return {
    maxChars: CONFIG.HANDOFF_MAX_MESSAGE_CHARS,
    maxPinned: CONFIG.HANDOFF_MAX_PINNED,
    maxRecent: CONFIG.HANDOFF_MAX_RECENT,
    maxSalience: CONFIG.HANDOFF_MAX_SALIENCE
  };
}

function loadSettings() {
  const defaults = getDefaultSettings();
  try {
    const data = JSON.parse(localStorage.getItem(CONFIG.SETTINGS_KEY) || '{}');
    state.settings = { ...defaults, ...data };
  } catch (e) {
    state.settings = defaults;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(CONFIG.SETTINGS_KEY, JSON.stringify(state.settings));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

function initSettingsUI(hud) {
  const panel = hud.querySelector('.health-bar-settings');
  if (!panel) return;

  panel.querySelectorAll('[data-setting]').forEach((input) => {
    const key = input.getAttribute('data-setting');
    if (!key) return;
    if (input.type === 'checkbox') {
      input.checked = Boolean(state.settings?.[key]);
    } else {
      input.value = state.settings?.[key] || input.value;
    }

    input.addEventListener('change', () => {
      if (input.type === 'checkbox') {
        state.settings[key] = input.checked;
      } else {
        state.settings[key] = input.value;
      }
      saveSettings();
      if (key === 'autoLoadHistory' && state.settings.autoLoadHistory) {
        startAutoLoadHistory();
      }
      updateHealthBar();
    });
  });
}

function saveHandoff(packet) {
  const payload = {
    createdAt: Date.now(),
    conversationId: state.conversationId,
    packet
  };
  localStorage.setItem(CONFIG.HANDOFF_STORAGE_KEY, JSON.stringify(payload));
}

function loadHandoff() {
  const raw = localStorage.getItem(CONFIG.HANDOFF_STORAGE_KEY);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    if (!payload || !payload.packet || !payload.createdAt) return null;
    if (Date.now() - payload.createdAt > CONFIG.HANDOFF_EXPIRY_MS) {
      localStorage.removeItem(CONFIG.HANDOFF_STORAGE_KEY);
      return null;
    }
    return payload;
  } catch (e) {
    localStorage.removeItem(CONFIG.HANDOFF_STORAGE_KEY);
    return null;
  }
}

function clearHandoff() {
  localStorage.removeItem(CONFIG.HANDOFF_STORAGE_KEY);
}

function openNewChat() {
  window.open('https://claude.ai/new', '_blank');
}

function startHandoff() {
  if (!state.messages || state.messages.length === 0) return;
  const packet = buildHandoffPacket(state.messages);
  saveHandoff(packet);
  openNewChat();
}

function copyHandoffToClipboard(button) {
  if (!state.messages || state.messages.length === 0) return;
  const packet = buildHandoffPacket(state.messages);
  const formatted = `${packet}\n\n---\n`;

  const onSuccess = () => {
    if (!button) return;
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = original;
    }, 1200);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(formatted)
      .then(onSuccess)
      .catch(() => {
        fallbackCopy(formatted, onSuccess);
      });
  } else {
    fallbackCopy(formatted, onSuccess);
  }
}

function fallbackCopy(text, onSuccess) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    onSuccess?.();
  } catch (e) {
    console.error('Failed to copy handoff:', e);
  }
  document.body.removeChild(textarea);
}

function isInputEmpty(input) {
  if (!input) return true;
  if (input.hasAttribute('contenteditable')) {
    const text = (input.innerText || input.textContent || '').trim();
    return text.length === 0;
  }
  const value = (input.value || '').trim();
  return value.length === 0;
}

function setDraftInputText(text) {
  const input = document.querySelector('[contenteditable="true"]') ||
                document.querySelector('textarea[placeholder*="Reply"]');
  if (!input) return false;
  if (!isInputEmpty(input)) return false;

  const formattedText = `${text}\n\n---\n`;
  input.focus();
  if (input.hasAttribute('contenteditable')) {
    input.textContent = '';
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    if (document.queryCommandSupported && document.queryCommandSupported('insertText')) {
      document.execCommand('insertText', false, formattedText);
    } else {
      input.textContent = formattedText;
    }
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: formattedText, inputType: 'insertText' }));
  } else {
    input.value = formattedText;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
}

function tryApplyHandoff(messages) {
  if (state.handoffApplied) return;
  const handoff = loadHandoff();
  if (!handoff) return;

  const hasUserMessages = messages.some(msg => msg.role === 'user' && !msg.isDraft);
  if (hasUserMessages) return;

  const attemptApply = () => {
    const applied = setDraftInputText(handoff.packet);
    if (applied) {
      clearHandoff();
      state.handoffApplied = true;
      if (state.handoffApplyTimer) {
        clearInterval(state.handoffApplyTimer);
        state.handoffApplyTimer = null;
      }
    }
  };

  if (!state.handoffApplyTimer) {
    let attempts = 0;
    state.handoffApplyTimer = setInterval(() => {
      attempts += 1;
      if (attempts > 20) {
        clearInterval(state.handoffApplyTimer);
        state.handoffApplyTimer = null;
        return;
      }
      attemptApply();
    }, 500);
  }
  attemptApply();
}

// ============================================================================
// MAIN UPDATE LOGIC
// ============================================================================

/**
 * Main function to update health bar
 */
function updateHealthBar() {
  // Parse conversation
  const { messages, totalTokens, totalCharsFromMessages, visibleChars } = parseConversation();

  if (messages.length === 0) {
    const totalCharsForPenalty = Math.max(totalCharsFromMessages, visibleChars);
    const healthData = {
      health: 100,
      tier: 'stable',
      reasons: [],
      hasUserMessages: false,
      debugStats: {
        totalChars: totalCharsForPenalty,
        totalTokens: Math.max(totalTokens, Math.ceil(totalCharsForPenalty / CONFIG.CHARS_PER_TOKEN)),
        messageCount: 0
      }
    };
    renderHUD(healthData);
    tryApplyHandoff(messages);
    return; // No conversation yet
  }

  state.messages = messages;

  // Detect instructions
  const instructionIndices = detectInstructions(messages);

  // Calculate health
  const totalCharsForPenalty = Math.max(totalCharsFromMessages, visibleChars);
  const healthData = calculateHealth(messages, totalTokens, instructionIndices, totalCharsForPenalty);

  // Render HUD
  renderHUD(healthData);

  // Inject pin icons
  injectPinIcons();

  // Apply pending handoff if present
  tryApplyHandoff(messages);
}

/**
 * Debounced update function
 */
function scheduleUpdate() {
  if (state.updateTimer) {
    clearTimeout(state.updateTimer);
  }

  state.updateTimer = setTimeout(() => {
    updateHealthBar();
  }, CONFIG.DEBOUNCE_MS);
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Extract conversation ID from URL or generate one
 */
function getConversationId() {
  // Claude's URL pattern: claude.ai/chat/{conversationId}
  const match = window.location.pathname.match(/\/chat\/([a-zA-Z0-9-]+)/);
  return match ? match[1] : 'default';
}

function countMessageElements() {
  return document.querySelectorAll('[data-testid^="user-message"], [data-testid^="assistant-message"]').length;
}

function getScrollContainer() {
  return document.scrollingElement || document.documentElement || document.body;
}

function isNearBottom(container) {
  return container.scrollHeight - container.scrollTop - container.clientHeight < 80;
}

function scrollToBottom(container) {
  container.scrollTop = container.scrollHeight;
}

function startAutoLoadHistory() {
  if (!CONFIG.AUTO_LOAD_HISTORY) return;
  if (!state.settings?.autoLoadHistory) return;
  if (state.autoLoadInProgress || state.autoLoadComplete) return;
  if (!window.location.pathname.startsWith('/chat/')) return;

  const container = getScrollContainer();
  if (!container) return;

  const initialCount = countMessageElements();
  if (initialCount === 0) return;

  const wasAtBottom = isNearBottom(container);
  const startTime = Date.now();
  let lastCount = initialCount;
  let idleTicks = 0;

  state.autoLoadInProgress = true;

  const timer = setInterval(() => {
    const elapsed = Date.now() - startTime;
    if (elapsed > CONFIG.AUTO_LOAD_MAX_MS || idleTicks >= CONFIG.AUTO_LOAD_IDLE_TICKS) {
      clearInterval(timer);
      state.autoLoadInProgress = false;
      state.autoLoadComplete = true;
      if (wasAtBottom) {
        scrollToBottom(container);
      }
      scheduleUpdate();
      return;
    }

    const currentCount = countMessageElements();
    if (currentCount > lastCount) {
      lastCount = currentCount;
      idleTicks = 0;
    } else {
      idleTicks += 1;
    }

    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    container.scrollTop = Math.max(0, container.scrollTop - step);
  }, CONFIG.AUTO_LOAD_INTERVAL_MS);
}

/**
 * Initialize the extension
 */
function initialize() {
  console.log('Context Health Bar initializing...');

  // Get conversation ID
  state.conversationId = getConversationId();

  // Load settings
  loadSettings();

  // Load pinned messages
  loadPinsFromStorage();

  // Initial update
  updateHealthBar();
  startAutoLoadHistory();

  // Watch for DOM changes
  const observer = new MutationObserver(() => {
    scheduleUpdate();
  });

  // Observe the main conversation container
  const conversationContainer = document.body;
  observer.observe(conversationContainer, {
    childList: true,
    subtree: true,
    characterData: true
  });

  // Watch for input changes
  const checkInput = () => {
    const input = document.querySelector('[contenteditable="true"]') ||
                  document.querySelector('textarea[placeholder*="Reply"]');
    if (input) {
      if (state.inputElement !== input) {
        if (state.inputElement) {
          state.inputElement.removeEventListener('input', scheduleUpdate);
        }
        state.inputElement = input;
        input.addEventListener('input', scheduleUpdate);
      }
    }
  };

  checkInput();
  setInterval(checkInput, 2000); // Re-check periodically in case input is recreated

  console.log('Context Health Bar initialized');
}

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
