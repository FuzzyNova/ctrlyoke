import React from "react";
import { HarnessIcon } from "../shared/HarnessIcon";
import type { HarnessId } from "@/types/messages";
import { TERMINAL_SESSION_STATUS } from "@/types/messages";
import type { TerminalSession } from "@store/terminalStore";
import { getShellCodiconName } from "@utils/terminalPresentation";
import { Icon } from "../shared/Icon";

interface TerminalSessionIconProps {
  session: Pick<
    TerminalSession,
    "harnessId" | "shellKind" | "status" | "stepName"
  >;
}

export const TerminalSessionIcon: React.FC<TerminalSessionIconProps> = ({
  session,
}) => {
  if (session.harnessId) {
    return (
      <HarnessIcon
        harnessId={session.harnessId as HarnessId}
        size={12}
        className="shrink-0"
      />
    );
  }

  const codiconName = getShellCodiconName(session.shellKind, session.stepName);
  if (codiconName) {
    return <Icon name={codiconName} className="text-xs shrink-0" />;
  }

  if (session.status === TERMINAL_SESSION_STATUS.RUNNING) {
    return (
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-indicator-success animate-pulse shrink-0" />
    );
  }
  if (session.status === TERMINAL_SESSION_STATUS.FAILED) {
    return (
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-indicator-error shrink-0" />
    );
  }
  return (
    <span className="inline-block w-1.5 h-1.5 rounded-full bg-description-fg/50 shrink-0" />
  );
};
