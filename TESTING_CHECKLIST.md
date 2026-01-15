# Testing Checklist - v1.0.1 Update

## What Changed
✅ Instruction distance penalty formula updated to threshold-based approach with 50% grace period
✅ Reduced no-instruction penalty from 40 to 30 points
✅ Updated all documentation (README, design doc, changelog)

## Files Modified
- [x] `content.js` - Updated `calculateHealth()` function
- [x] `README.md` - Updated health calculation section
- [x] `docs/plans/2026-01-15-context-health-bar-design.md` - Updated Component 1 formula
- [x] `CHANGELOG.md` - Created with version history

## Testing Steps

### 1. Reload Extension
- [ ] Go to `chrome://extensions/`
- [ ] Find "Context Health Bar for Claude"
- [ ] Click the reload icon (circular arrow)

### 2. Test Early Conversation Behavior
- [ ] Start a new conversation on claude.ai
- [ ] Send a simple instruction like "Help me brainstorm ideas"
- [ ] Get one response from Claude
- [ ] **Expected:** Health should be 90-100% (not 60% like before)
- [ ] **Verify:** Tooltip shows minimal/no instruction distance penalty

### 3. Test Natural Back-and-Forth
- [ ] Continue the conversation with 3-4 more exchanges
- [ ] **Expected:** Health stays green (80-100%) during normal chat
- [ ] **Verify:** Grace period is working (no penalty until >50% after instruction)

### 4. Test Long Conversation Drift
- [ ] Continue conversation to 15-20+ exchanges
- [ ] Don't re-state instructions
- [ ] **Expected:** Health gradually declines to yellow/orange (50-79%)
- [ ] **Verify:** Tooltip shows "Primary instruction Xk tokens back" message

### 5. Test Manual Pinning
- [ ] Hover over any user message
- [ ] Click the pin icon (📌)
- [ ] **Expected:** Health should improve if that message is more recent
- [ ] **Verify:** Pin icon shows as filled/highlighted
- [ ] Refresh page and verify pin persists

### 6. Test Token Penalties
- [ ] Continue conversation until ~15k-20k tokens (use Dev Tools Console to check)
- [ ] **Expected:** Additional token penalty appears in tooltip
- [ ] **Verify:** Penalty increases at 15k/25k/40k token thresholds

### 7. Verify No Breaking Changes
- [ ] Health bar still renders correctly in bottom-right
- [ ] Colors transition smoothly (green → yellow → red)
- [ ] Tooltip appears on hover with clear explanations
- [ ] No console errors in browser DevTools

## Expected Behavior Changes

| Scenario | Old v1.0.0 | New v1.0.1 |
|----------|------------|------------|
| 2-message exchange | ~60% health | ~90-100% health |
| 5-message natural chat | ~40-50% health | ~85-95% health |
| Instruction at 80% back | ~52% health | ~76% health |
| Long conversation (30k tokens) | Red/critical | Yellow/degrading |

## Success Criteria
- [x] Code updated correctly with threshold formula
- [x] Documentation matches implementation
- [ ] Testing confirms improved early conversation experience
- [ ] No regression in long conversation detection
- [ ] Users report extension "feels more accurate"

## Rollback Plan
If new formula causes issues:
1. Revert `content.js` lines 276-295 to original linear formula
2. Change `instructionPenalty = (distanceRatio - 0.5) * 80` back to `instructionPenalty = distanceRatio * 60`
3. Remove grace period conditional
4. Reload extension

---

**Notes:**
- Original aggressive formula was catching drift too early
- New formula gives natural conversation room to breathe
- Still maintains warning capability for genuine long-context issues
- Threshold approach aligns with how users actually experience degradation
