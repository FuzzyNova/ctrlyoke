import { HEADLESS_STEER_DELIVERIES } from "../../../types/DashboardConstants";
import { StreamJsonHeadlessControlChannel } from "../shared/StreamJsonHeadlessControlChannel";
import { CLAUDE_CONTROL } from "./ClaudeProtocolConstants";

/** Claude Code's stream-json input channel for one headless step. */
export class ClaudeHeadlessControlChannel extends StreamJsonHeadlessControlChannel {
  readonly holdOpenForBackgroundWork = true;

  constructor() {
    super(
      {
        requestType: CLAUDE_CONTROL.REQUEST_TYPE,
        responseType: CLAUDE_CONTROL.RESPONSE_TYPE,
        canUseToolSubtype: CLAUDE_CONTROL.CAN_USE_TOOL_SUBTYPE,
        successSubtype: CLAUDE_CONTROL.SUCCESS_SUBTYPE,
        denyBehavior: CLAUDE_CONTROL.DENY_BEHAVIOR,
        resultType: CLAUDE_CONTROL.RESULT_TYPE,
      },
      HEADLESS_STEER_DELIVERIES.INJECT
    );
  }

  protected createUserMessageRecord(text: string): Record<string, unknown> {
    return {
      type: CLAUDE_CONTROL.USER_TYPE,
      message: { role: CLAUDE_CONTROL.USER_ROLE, content: text },
      parent_tool_use_id: null,
    };
  }
}
