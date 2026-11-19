import { beforeEach, describe, expect, it } from "vitest";
import {
  PROMPT_HISTORY_LIMIT,
  PROMPT_HISTORY_MAX_TEXT_LENGTH,
  usePromptHistoryStore,
} from "@store/promptHistoryStore";
import { PROMPT_HISTORY_KINDS } from "@root/types/DashboardConstants";

const history = () => usePromptHistoryStore.getState();
const texts = () => history().entries.map((entry) => entry.text);

beforeEach(() => {
  usePromptHistoryStore.setState({ entries: [] });
});

describe("promptHistoryStore", () => {
  it("keeps prompts newest first, trimmed, and skips blank text", () => {
    history().record("  first  ", PROMPT_HISTORY_KINDS.SENT);
    history().record("second", PROMPT_HISTORY_KINDS.STEER);
    history().record("   ", PROMPT_HISTORY_KINDS.SENT);

    expect(texts()).toEqual(["second", "first"]);
  });

  it("moves a repeated prompt to the top with its latest kind", () => {
    history().record("queued by mistake", PROMPT_HISTORY_KINDS.SENT);
    history().record("other", PROMPT_HISTORY_KINDS.SENT);
    history().record("queued by mistake", PROMPT_HISTORY_KINDS.STEER);

    expect(history().entries).toMatchObject([
      { text: "queued by mistake", kind: PROMPT_HISTORY_KINDS.STEER },
      { text: "other", kind: PROMPT_HISTORY_KINDS.SENT },
    ]);
  });

  it("drops the oldest entries past the limit and skips huge prompts", () => {
    for (let i = 0; i <= PROMPT_HISTORY_LIMIT; i++) {
      history().record(`prompt ${i}`, PROMPT_HISTORY_KINDS.SENT);
    }
    history().record(
      "x".repeat(PROMPT_HISTORY_MAX_TEXT_LENGTH + 1),
      PROMPT_HISTORY_KINDS.SENT
    );

    expect(texts()).toHaveLength(PROMPT_HISTORY_LIMIT);
    expect(texts()[0]).toBe(`prompt ${PROMPT_HISTORY_LIMIT}`);
    expect(texts()).not.toContain("prompt 0");
  });

  it("remembers a replaced draft only when the list lacks it", () => {
    history().record("sent earlier", PROMPT_HISTORY_KINDS.SENT);
    history().record("sent last", PROMPT_HISTORY_KINDS.SENT);

    history().rememberDraft("sent earlier");
    expect(texts()).toEqual(["sent last", "sent earlier"]);

    history().rememberDraft("never sent");
    expect(history().entries[0]).toMatchObject({
      text: "never sent",
      kind: PROMPT_HISTORY_KINDS.DRAFT,
    });
  });
});
