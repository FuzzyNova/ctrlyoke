import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { HARNESS_IDS, HARNESS_INFO } from "@root/types/DashboardConstants";
import type { HarnessId } from "@root/types/DashboardConstants";

interface Props {
  settings: FullGlobalSettings;
  onUpdate: (path: string, value: unknown, scope: "workspace" | "user") => void;
}

const CLI_HARNESSES: HarnessId[] = [
  HARNESS_IDS.COPILOT_CLI,
  HARNESS_IDS.CLAUDE_CLI,
  HARNESS_IDS.CODEX_CLI,
  HARNESS_IDS.OPENCODE_CLI,
  HARNESS_IDS.QWEN_CLI,
  HARNESS_IDS.GEMINI_CLI,
  HARNESS_IDS.COPILOT_CHAT,
] as HarnessId[];

export function HarnessesSection({ settings, onUpdate }: Props) {
  const models = settings.settings.models;
  const additionalArgs = settings.settings.additionalArgs;
  const s = "user" as const;

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
        Harness Defaults
      </h3>
      <p className="text-xs text-description-fg -mt-2">
        Configure the default model and additional CLI args for each harness. These are used when no workflow-level override is set.
      </p>
      <div className="space-y-4">
        {CLI_HARNESSES.map((harnessId) => {
          const harnessKey = harnessId as keyof typeof HARNESS_INFO;
          const info = HARNESS_INFO[harnessKey];
          const isChat = harnessId === HARNESS_IDS.COPILOT_CHAT;
          return (
            <div
              key={harnessId}
              className="border border-panel-border rounded p-3 space-y-2"
            >
              <div className="text-sm font-medium text-foreground">{info.name}</div>
              <div className="grid grid-cols-[80px_1fr] items-center gap-2">
                <label className="text-xs text-description-fg">Model</label>
                <input
                  type="text"
                  value={(models as Record<string, string | undefined>)[harnessId] ?? ""}
                  onChange={(e) =>
                    onUpdate(
                      `models.${harnessId}`,
                      e.target.value || undefined,
                      s
                    )
                  }
                  placeholder="Default"
                  className="bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
                />
              </div>
              {!isChat && (
                <div className="grid grid-cols-[80px_1fr] items-center gap-2">
                  <label className="text-xs text-description-fg">Extra args</label>
                  <input
                    type="text"
                    value={(additionalArgs as Record<string, string | undefined>)[harnessId] ?? ""}
                    onChange={(e) =>
                      onUpdate(
                        `additionalArgs.${harnessId}`,
                        e.target.value || undefined,
                        s
                      )
                    }
                    placeholder="None"
                    className="bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
