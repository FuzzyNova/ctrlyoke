import type { HarnessId, WorkflowStep } from "../types/CtrlYokeTypes";

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
}

/**
 * When resuming a session, only re-attach agent/skill instructions that are not
 * already present in the most relevant prior prompt for that session.
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

    const previousRuntime = this.findPreviousRuntime(params);
    if (!previousRuntime) {
      return { agent: currentAgent, skills: currentSkills };
    }

    const agent =
      currentAgent && currentAgent !== previousRuntime.agent
        ? currentAgent
        : undefined;

    const previousSkills = new Set(previousRuntime.skills ?? []);
    const skills = currentSkills?.filter((skill) => !previousSkills.has(skill));

    return {
      agent,
      skills: skills?.length ? skills : undefined,
    };
  }

  private static findPreviousRuntime(
    params: ResumeAttachmentResolverParams
  ): WorkflowStep["_runtime"] | undefined {
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
      if (params.resolvedSessionId) {
        if (runtime.sessionId === params.resolvedSessionId) {
          return runtime;
        }
        continue;
      }
      return runtime;
    }

    return undefined;
  }
}
