# Changelog

## [1.0.1] - 2026-01-15 - Post-MVP Testing Update

### Changed
- **Instruction Distance Penalty Formula** - Updated from aggressive linear scaling to threshold-based approach with grace period
  
  **Old behavior:**
  - Linear penalty: `distanceRatio × 60` (0-60 points)
  - Health dropped to 60% after just one exchange
  - Too punishing for early natural conversation
  
  **New behavior:**
  - Grace period: No penalty if <50% of conversation is after instruction
  - Scaled penalty: `(distanceRatio - 0.5) × 80` for ratios >0.5 (0-40 points max)
  - Early conversations can breathe naturally before triggering warnings
  - Still catches genuine instruction drift in longer conversations
  
  **Example impact:**
  - Short 2-message exchange: Health stays ~90-100% (was ~60%)
  - Long conversation with instruction at 80% back: Health ~76% (was ~52%)

- **No-Instruction Penalty** - Reduced from 40 to 30 points to align with new scaling

### Rationale
First real-world testing revealed the linear penalty was too aggressive for early conversations. The 50% threshold provides natural back-and-forth room while still alerting users to genuine context drift in longer conversations.

### Files Modified
- `content.js` - Updated `calculateHealth()` function (lines 276-295)
- `README.md` - Updated health calculation explanation
- `docs/plans/2026-01-15-context-health-bar-design.md` - Updated Component 1 penalty formula and rationale

---

## [1.0.0] - 2026-01-15 - Initial MVP Release

### Added
- Chrome extension for claude.ai with context health visualization
- Token estimation using character ÷ 4 heuristic
- Instruction detection with automatic and manual (pin) modes
- Health calculation with three penalty components:
  - Instruction distance penalty
  - Total token penalty
  - Noise penalties (long monologues, assistant dominance)
- Retro game-style HUD with color-coded health tiers
- Real-time updates via MutationObserver
- Pin icons for marking core instructions
- Hover tooltips explaining health penalties
- localStorage persistence for pinned messages
- Complete documentation and installation guide
