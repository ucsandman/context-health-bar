# Context Health Bar Extension - Design Document

**Date:** 2026-01-15
**Target Platform:** Claude.ai (Chrome Extension MVP)
**Status:** Design Complete, Ready for Implementation

---

## Overview

A Chrome browser extension that visualizes LLM context degradation as a video game-style health bar. The extension estimates when Claude's performance is likely degrading due to long context and instruction drift, providing users with a heuristic reliability signal.

**Key Principle:** This is not an exact token counter or internal model insight. It's a believable proxy that correlates with user-experienced degradation.

---

## 1. Architecture

### Extension Structure
- **Manifest V3** Chrome extension
- **Single content script** (`content.js`) injected into `claude.ai`
- **Minimal CSS** (`healthbar.css`) for HUD styling
- **localStorage** for persisting pinned message state
- No background service worker needed

### Core Flow
1. Content script injects when `claude.ai` loads
2. `MutationObserver` watches for conversation changes
3. DOM parser extracts user/assistant messages
4. Token estimator calculates approximate token counts (char count ÷ 4)
5. Instruction detector identifies core instructions using heuristics
6. Health calculator computes score based on instruction distance + token count + noise
7. HUD renderer displays floating health bar near input box
8. Real-time updates on conversation changes (debounced)

### Technical Decisions
- DOM parsing uses stable Claude message container selectors
- Health calculation runs on debounced intervals (not every keystroke)
- HUD uses fixed position overlay to avoid layout interference
- Pin state stored as `{ conversationId: [messageIds] }` in localStorage

---

## 2. Conversation Parsing & Token Estimation

### DOM Parsing Strategy

Target Claude's conversation structure:
- Locate main conversation thread container
- Extract all message elements in order
- Identify role (user vs assistant) from Claude's role markers
- Extract text content (handle code blocks gracefully)
- Get current draft from textarea input

### Token Estimation

**Formula:** `estimatedTokens = Math.ceil(charCount / 4)`

- Apply to each message independently
- Track cumulative token position for distance calculations
- Example:
  - Msg1: 400 chars = 100 tokens (position 0-100)
  - Msg2: 800 chars = 200 tokens (position 100-300)
  - Total: 300 tokens

### Noise Detection

Flag patterns that correlate with degradation:
- **Long monologue:** Assistant messages >4000 chars (+10 health penalty)
- **Assistant dominance:** Assistant tokens >70% of total (+15 penalty)
- Penalties stack

### Edge Cases
- Ignore empty messages
- Treat code blocks as denser (1 token per line approximation)
- Default to health=100 if parsing fails (fail-safe)

---

## 3. Instruction Detection

### Automatic Detection Heuristics

**Balanced approach** to identify core instructions:

1. **Imperative phrase matching:**
   - Search for: "you are", "act as", "always", "never", "do not", "don't", "must", "should", "follow these", "remember to"
   - Requires **2+ matches** to flag as instruction

2. **Early conversation bias:**
   - First 3 user messages get extra weight
   - Auto-flag first user message if it contains bullet lists (`- `, `* `, `1. ` patterns)

3. **High imperative density:**
   - Messages with 2+ imperatives AND <800 chars = focused instruction

### Manual Pinning

- Pin icon (📌) appears on hover next to each user message
- Click to toggle pinned state
- Pinned messages always treated as core instructions
- Visual feedback: filled pin = pinned, outline = unpinned

### Storage Format

```javascript
localStorage["claude_healthbar_pins"] = {
  "conversation_abc123": ["msg_5", "msg_12"],
  "conversation_xyz789": ["msg_3"]
}
```

### Instruction Tracking

- Maintain array of instruction message indices
- Track token position of **last (most recent) instruction**
- This position drives the distance calculation

---

## 4. Health Score Calculation

### Formula: Start at 100, subtract penalties, clamp to 0-100

### Component 1: Instruction Distance Penalty (Primary Factor)

**UPDATED:** Threshold-based approach with grace period for natural conversation

```javascript
if (lastInstructionTokenPos exists) {
  distanceFromEnd = totalTokens - lastInstructionTokenPos
  distanceRatio = distanceFromEnd / totalTokens
  
  // Only penalize if >50% of conversation is after last instruction
  if (distanceRatio > 0.5) {
    penalty = (distanceRatio - 0.5) * 80  // 0-40 points
  } else {
    penalty = 0  // Grace period for early conversation
  }
} else {
  penalty = 30  // No instructions detected (reduced from 40)
}
```

**Rationale:** 
- Gives early conversations room to breathe (no penalty until >50% is after instruction)
- If 80% of context is after instruction, lose ~24 health points
- Prevents false alarms during natural back-and-forth
- Still catches genuine instruction drift in long conversations

### Component 2: Total Token Penalty

```javascript
if (totalTokens > 40000)      penalty = 30
else if (totalTokens > 25000) penalty = 20
else if (totalTokens > 15000) penalty = 10
else                          penalty = 0
```

**Rationale:** Realistic degradation curve - mirrors when users notice problems.

### Component 3: Noise Penalties

From parsing analysis:
- Long assistant monologues: +10
- Assistant dominates (>70% tokens): +15

### Final Calculation

```javascript
health = 100 - instructionDistancePenalty - tokenPenalty - noisePenalties
health = Math.max(0, Math.min(100, health))
```

### Tier Mapping

| Health | Tier | Color |
|--------|------|-------|
| 80-100 | Stable | Green |
| 50-79 | Degrading | Yellow/Orange |
| 20-49 | Unreliable | Red |
| 0-19 | Critical | Dark Red |

---

## 5. Visualization

### HUD Design

**Positioning:**
- Fixed position overlay
- Bottom-right of viewport
- Above Claude's input box, non-intrusive
- ~200px wide × ~60px tall

**Aesthetic:**
- Retro game style with clean borders
- Compact and unobtrusive

### Visual Elements

**1. Health Bar:**
- Horizontal bar with rounded corners
- Dynamic gradient based on tier:
  - 80-100: Green (#4ade80 → #22c55e)
  - 50-79: Yellow/Orange (#fbbf24 → #f59e0b)
  - 20-49: Red (#ef4444 → #dc2626)
  - 0-19: Dark Red (#991b1b)
- Smooth CSS transition (0.5s ease)
- Bar fills left-to-right proportional to health %

**2. Label:**
- "Context Health" text above bar
- Numeric percentage (optional, shown on hover)

**3. Animations:**
- Subtle pulse when crossing tier boundaries
- Smooth bar transitions

### Tooltip (on hover)

Dynamically generated explanation:
```
Context Health: 64%
• Primary instruction 12k tokens back
• Conversation length: 28k tokens
• Long assistant responses detected
```

Shows active penalties contributing to score.

### Pin Icons

- Small clickable pin (📌) next to each user message
- Appears on message hover
- Filled = pinned, outline = unpinned
- Positioned top-right of message bubble

---

## 6. Live Updates

### Update Triggers

Health bar recalculates when:
- New message sent or received
- User types in input box (debounced 500ms)
- Conversation DOM changes (via MutationObserver)

### Preview Behavior

Before sending a message, bar reflects **post-send state** including draft input in calculation.

---

## 7. Safety & UX

### Ethical Guidelines

- **Do NOT claim accuracy** or internal model insight
- Label as "Context Health" or "Reliability Meter"
- Frame as signal strength, not battery percentage
- No data collection
- No external network requests

### User Messaging

Tooltip explanations use plain language:
- "Primary instruction far from recent context"
- "Conversation length is high"
- Not technical jargon about attention or tokens

---

## 8. Out of Scope for MVP

**Deferred to v2:**
- Auto-repair/instruction refresh feature
- ChatGPT support (focusing on Claude only)
- Advanced conflict detection between instructions
- Token-accurate counting (heuristic is sufficient)
- Settings panel or customization

---

## File Structure

```
context-health-bar/
├── manifest.json          # Manifest V3 configuration
├── content.js             # Main content script (all logic)
├── healthbar.css          # HUD styling
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md              # Installation instructions
```

---

## Success Criteria

MVP is successful if:
1. Health bar renders correctly on claude.ai
2. Health degrades noticeably when instructions are far back
3. Manual pinning works and affects score
4. Tooltip explanations are clear
5. No performance issues or UI conflicts with Claude
6. Users report "it confirms what I already felt"

---

## Known Limitations & Future Extensions

### Where Heuristics May Be Wrong

- Character ÷ 4 doesn't match Claude's actual tokenizer
- Imperative phrase matching misses nuanced instructions
- Can't detect semantic instruction conflicts
- Doesn't account for Claude's actual context window size
- No insight into real attention weights

### Extension Opportunities

- **Auto-repair:** Summarize and re-inject instructions when health is low
- **Multi-platform:** Add ChatGPT support
- **Advanced detection:** Use lightweight NLP for better instruction parsing
- **Analytics:** Track health over time per conversation (privacy-preserving)
- **Customization:** User-adjustable thresholds and penalties
- **Export:** Save health history with conversation exports

---

## Implementation Notes

- Start with DOM inspection of Claude's current structure
- Build parser incrementally, test with real conversations
- Health formula constants may need tuning based on user feedback
- Pin icon injection requires careful CSS to avoid breaking Claude's layout
- localStorage needs conversation ID extraction from Claude's URL or DOM
