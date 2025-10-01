# Background Polling Implementation

## Overview

This document describes the implementation of background polling for Copilot availability detection in FlightPath. This replaces the lazy-loading approach with proactive detection and user feedback.

## Problem Solved

**Previous Behavior:**
- FlightPath did a single passive check for Copilot on startup
- When user tried to execute a workflow, they'd see "automation unavailable" 
- Only when sending the prompt did FlightPath try to activate Copilot
- This caused confusing UX where first execution appeared to fail

**New Behavior:**
- FlightPath starts background polling immediately on activation
- Status bar shows real-time initialization progress
- Workflows are blocked until Copilot is confirmed ready or unavailable
- Clear feedback about system state at all times

## Implementation Details

### Polling Strategy

**Timing:**
- Poll interval: 5 seconds
- Maximum duration: 30 seconds (6 attempts total)
- First check: Passive (just check if extensions are active)
- Second check onwards: Active (attempt to activate extensions)

**States:**
1. `initializing` - First 5 seconds, checking extensions
2. `waiting` - Extensions found but not active yet, attempting activation
3. `ready` - Copilot automation confirmed available
4. `unavailable` - 30 seconds elapsed without successful detection

### Code Architecture

#### CopilotIntegration.ts

**New Properties:**
```typescript
private initializationStatus: CopilotStatus = 'initializing';
private pollingAttempts: number = 0;
private readonly maxPollingAttempts: number = 6;
private readonly pollingInterval: number = 5000;
private pollingTimer: NodeJS.Timeout | undefined;
private statusChangeEmitter = new vscode.EventEmitter<CopilotStatus>();
public readonly onDidChangeStatus = this.statusChangeEmitter.event;
```

**New Methods:**
- `startBackgroundPolling()` - Initiates polling sequence
- `pollCopilotAvailability()` - Recursive polling logic
- `retryDetection()` - Manually restart polling
- `getInitializationStatus()` - Get current state
- `isReady()` - Check if ready for workflows
- `getDetailedStatus()` - Comprehensive status information

**Key Changes:**
- `initialize()` now calls `startBackgroundPolling()` instead of single check
- Status changes emit events for subscribers
- Progressive strategy: passive → active activation

#### FlightPathManager.ts

**Status Bar Updates:**
Shows different states based on Copilot initialization:
- `$(loading~spin) FlightPath - Initializing...`
- `$(clock) FlightPath - Waiting for Copilot (X/6)`
- `$(rocket) FlightPath - Ready`
- `$(warning) FlightPath - Setup Required`

**Workflow Blocking:**
`executePromptFile()` now checks readiness before showing dialog:
- `initializing` → "Please wait and try again"
- `waiting` → "Waiting for Copilot... (attempt X/6)"
- `unavailable` → "Setup required" with retry option
- `ready` → Proceed with enthusiastic confirmation

**Event Subscription:**
```typescript
this.copilotIntegration.onDidChangeStatus((status) => {
    this.updateStatusBar();
});
```

#### extension.ts

**New Command:**
```typescript
flightpath.retryCopilotDetection - Manually restart polling
```

### User Experience Flow

#### On Fresh VS Code Start

```
[Extension Activates]
    ↓
Status Bar: "🔄 Initializing..."
    ↓
[Polling starts - attempt 1, passive check]
    ↓
Not found? → Wait 5 seconds
    ↓
[Polling attempt 2 - try activation]
    ↓
Found? → Status Bar: "✅ Ready"
Not found? → Wait 5 seconds → Continue polling
    ↓
[Max 6 attempts over 30 seconds]
    ↓
Still not found? → Status Bar: "⚠️ Setup Required"
```

#### When User Tries to Run Workflow

**If initializing:**
- Show warning: "FlightPath is still initializing..."
- Offer "Retry" button (waits 1s and checks again)

**If waiting:**
- Show warning: "Waiting for Copilot... (attempt X/6)"
- Offer "Retry" button (waits 2s and checks again)

**If unavailable:**
- Show error: "Copilot automation is unavailable"
- Offer "Retry Detection" (restarts polling)
- Offer "View Requirements" (shows troubleshooting)

**If ready:**
- Show enthusiastic message: "✅ Copilot automation is ready!"
- Proceed immediately with workflow execution

### Benefits

1. **Transparent State** - Users always know what's happening
2. **No False Negatives** - Doesn't report unavailable when it's just not loaded yet
3. **Handles Slow Activation** - Gives Copilot time to activate on slow machines
4. **Non-Blocking** - Doesn't freeze VS Code during detection
5. **Manual Retry** - Users can restart detection if needed
6. **Clear Feedback** - Status bar and dialogs communicate system state

### Testing Scenarios

1. ✅ **Fresh VS Code start with Copilot installed**
   - Should show "Initializing" → "Waiting" → "Ready"
   - Takes 5-10 seconds typically

2. ✅ **Fresh VS Code start without Copilot**
   - Should show "Initializing" → "Waiting" → "Setup Required"
   - Takes full 30 seconds

3. ✅ **Copilot already active**
   - Should show "Ready" immediately or within 5 seconds

4. ✅ **User tries to run workflow while initializing**
   - Should be blocked with helpful message
   - Can retry and succeed once ready

5. ✅ **Manual retry detection**
   - Command restarts polling from beginning
   - Status updates accordingly

### Configuration

Currently uses hardcoded values (can be made configurable later):

```typescript
pollingInterval: 5000,      // 5 seconds between attempts
maxPollingAttempts: 6,      // 6 attempts = 30 seconds total
```

### Future Enhancements

Potential improvements for future versions:

- [ ] Configurable polling interval and timeout
- [ ] More granular status messages (e.g., "Activating extension...")
- [ ] Notification when Copilot becomes ready during work
- [ ] Background re-polling if Copilot becomes unavailable
- [ ] Telemetry for polling success rates and timing
- [ ] Visual progress indicator in status bar

### API Changes

**New Public API:**

```typescript
// CopilotIntegration
getInitializationStatus(): CopilotStatus
isReady(): boolean
getDetailedStatus(): { initializationStatus, isReady, message, ... }
retryDetection(): Promise<void>
onDidChangeStatus: Event<CopilotStatus>

// FlightPathManager
retryCopilotDetection(): Promise<void>
getCopilotDetailedStatus(): { ... }

// VS Code Command
flightpath.retryCopilotDetection
```

### Backward Compatibility

All existing APIs remain functional:
- `isIntegrationAvailable()` - Still works
- `getStatus()` - Still works
- `testAutomation()` - Still works
- `sendPrompt()` - Still works with same behavior

The only change is the initialization timing - it now happens in the background with better feedback.

---

**Implementation Date:** October 1, 2025  
**Status:** ✅ Complete and Tested  
**Version:** 0.2.0 (next release)
