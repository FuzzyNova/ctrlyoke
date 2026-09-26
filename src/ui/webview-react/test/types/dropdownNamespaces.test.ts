import { describe, expect, it } from "vitest";
import {
  getResumeSessionOptions,
  resumeSessionSelection,
} from "@/types/dropdownNamespaces";
import { SESSION_ID_SENTINELS } from "@root/types/DashboardConstants";

const GUID = "63017930-45b0-4ec4-8094-8a57751e905b";

describe("resumeSessionSelection", () => {
  it("uses schema UI labels and writes the Final Step sentinel", () => {
    const options = getResumeSessionOptions("Inherit (Resume)");
    expect(options.map(({ label }) => label)).toEqual([
      "Inherit (Resume)",
      "Resume",
      "New Session",
      "Final Step Session",
    ]);
    expect(options[options.length - 1]).toMatchObject({
      schemaPath: "resumeSession",
      pseudo: {
        writes: "resumeSession: true, sessionId: <FINAL_STEP sentinel>",
      },
    });
  });

  it("keeps an explicit session ID while the selection stays Yes", () => {
    expect(resumeSessionSelection("yes", GUID)).toEqual({
      resumeSession: true,
      sessionId: GUID,
    });
  });

  it("clears a session ID when the selection falls back to inherit", () => {
    // The regression: the drawer greys the Session ID input out here and shows
    // the inherited value instead, so a retained GUID is invisible but still
    // resolved at execution time — the step resumed a session the user had
    // already switched away from.
    expect(resumeSessionSelection("default", GUID)).toEqual({
      resumeSession: undefined,
      sessionId: "",
    });
  });

  it("clears a session ID when the selection turns resume off", () => {
    expect(resumeSessionSelection("no", GUID)).toEqual({
      resumeSession: false,
      sessionId: "",
    });
  });

  it("swaps between the Final Step sentinel and an explicit ID", () => {
    expect(resumeSessionSelection(SESSION_ID_SENTINELS.FINAL_STEP, "")).toEqual(
      {
        resumeSession: true,
        sessionId: SESSION_ID_SENTINELS.FINAL_STEP,
      }
    );
    expect(
      resumeSessionSelection("yes", SESSION_ID_SENTINELS.FINAL_STEP)
    ).toEqual({ resumeSession: true, sessionId: "" });
  });

  it("treats a missing session ID as empty", () => {
    expect(resumeSessionSelection("yes", undefined)).toEqual({
      resumeSession: true,
      sessionId: "",
    });
  });
});
