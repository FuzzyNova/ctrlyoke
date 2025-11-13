---
applyTo: "src/ui/**"
---

<purpose>
Status display and user interaction. Currently: StatusBarManager only.
</purpose>

<statusBarManager>
**Responsibilities:**
- Status bar item lifecycle and updates
- Visual feedback for workflow state (icons, colors, tooltips)
- Progress indication during execution
- Auto-hide success messages after 5 seconds

**State visualization:**

- Idle: `$(compass) FlightPath` - default state, ready
- Running: `$(compass-dot) FlightPath N/M` - progress with prominent background
- Paused: `$(debug-pause) FlightPath N/M` - warning background
- Completed: `$(check) FlightPath Complete` - success, auto-hides after 5s
- Error: `$(error) FlightPath Error` - error background

**Icon selection:**

- `$(compass)` - Navigation/direction theme fits "FlightPath" metaphor
- `$(compass-dot)` - Animated feel for running state
- `$(debug-pause)` - Standard VS Code pause icon
- `$(check)` - Clear success indicator
- `$(error)` - Standard VS Code error icon

**Background colors:**

- Prominent: Running and completed (blue)
- Warning: Paused (yellow/orange)
- Error: Error state (red)
- Use ThemeColor for automatic theme adaptation
  </statusBarManager>

<importantContext>on:\*\*

- `calculateProgress()` returns `{ current, total, percentage }`
- Current = items completed (not items sent)
- Total = all items in queue
- Percentage for future progress bar visualization

**Auto-hide behavior:**

- Success message shows for 5 seconds then reverts to idle
- Prevents status bar clutter after workflow completes
- Error messages do NOT auto-hide (user must acknowledge)

**Click behavior:**

- Default command: `flightpath.openPanel` (future WebView panel)
- Currently shows "not implemented" message
- Future: WebView with workflow visualization, history, logs

**Why status bar vs. notifications:**

- Status bar: Non-intrusive, always visible, real-time updates
- Notifications: Too intrusive for frequent state changes
- Output channel: Detailed logs for CLI mode (optional visibility)

**Future enhancements:**

- WebView panel with workflow visualization
- Execution history and replay
- Interactive progress tracking
- Log filtering and search
  </importantContext>

<relatedFiles>
- `../flightpath/FlightPathManager.ts` - Updates status bar on queue state changes
- `../flightpath/PromptQueue.ts` - Emits state change events
- `../types/FlightPathTypes.ts` - QueueState interface defines status values
</relatedFiles>
