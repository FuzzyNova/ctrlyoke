import type { HarnessId, WorkflowStep } from "../types/CtrlYokeTypes";
import type { SessionAttachments } from "./SessionAttachmentLedger";

export interface ResumeAttachmentResolution {
  agent: string | undefined;
  skills: string[] | undefined;
}

interface ResumeAttachmentResolverParams {
  promptIndex: number;
  allPrompts: WorkflowStep[];
  harness?: HarnessId;
  resumeSession?: boolean;
  resolvedSessionId?: string;
  agent?: string;
  skills?: string[];
  /** What the session received outside this run, from `SessionAttachmentLedger`. */
  priorAttachments?: SessionAttachments;
}

/**
 * When resuming a session, only re-attach agent/skill instructions that the
 * session has not already received.
 */
export class ResumeAttachmentResolver {
  static resolve(
    params: ResumeAttachmentResolverParams
  ): ResumeAttachmentResolution {
    const currentAgent = params.agent;
    const currentSkills = params.skills?.length ? params.skills : undefined;

    if (!params.resumeSession) {
      return { agent: currentAgent, skills: currentSkills };
    }

    const previous = this.findPreviousAttachments(params);
    if (!previous) {
      return { agent: currentAgent, skills: currentSkills };
    }

    const agent =
      currentAgent && !previous.agents.has(currentAgent)
        ? currentAgent
        : undefined;
    const skills = currentSkills?.filter(
      (skill) => !previous.skills.has(skill)
    );

    return {
      agent,
      skills: skills?.length ? skills : undefined,
    };
  }

  /**
   * With a session ID, everything the session received: the union over every
   * earlier completed step on it plus `priorAttachments`. A step's
   * `_runtime.skills` lists only what that step sent, so comparing against the
   * most recent step alone would re-send what an earlier step attached.
   * Without one, the most recent completed step on the same harness.
   */
  private static findPreviousAttachments(
    params: ResumeAttachmentResolverParams
  ): { agents: Set<string>; skills: Set<string> } | undefined {
    const agents = new Set(params.priorAttachments?.agents ?? []);
    const skills = new Set(params.priorAttachments?.skills ?? []);
    let found = params.priorAttachments !== undefined;

    for (let i = params.promptIndex - 1; i >= 0; i--) {
      const runtime = params.allPrompts[i]?._runtime;
      if (!runtime?.completedAt) {
        continue;
      }
      if (
        params.harness &&
        runtime.harness &&
        runtime.harness !== params.harness
      ) {
        continue;
      }
      if (
        params.resolvedSessionId &&
        runtime.sessionId !== params.resolvedSessionId
      ) {
        continue;
      }
      found = true;
      if (runtime.agent) {
        agents.add(runtime.agent);
      }
      for (const skill of runtime.skills ?? []) {
        skills.add(skill);
      }
      if (!params.resolvedSessionId) {
        break;
      }
    }

    return found ? { agents, skills } : undefined;
  }
}
