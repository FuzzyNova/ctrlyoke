# Coordination

Several agents can work in the same checkout at once: the members of a
[parallel group](/workflows/parallel-steps), two workflows you started side by
side, or an agent session you opened yourself. The coordination board lets them
tell each other what they are doing. An agent can post a note, read the notes
others posted, and claim the files it is about to edit so the others know to
stay away.

```yaml
mcpServers: [ctrlyoke]
steps:
  - parallel:
      - name: api
        prompt: >-
          Before editing, claim the files you will change with claim_paths.
          If a claim is denied, read_notes and work on something else.
          Implement the new endpoint in src/api/.
      - name: ui
        prompt: >-
          Before editing, claim the files you will change with claim_paths.
          If a claim is denied, read_notes and work on something else.
          Build the settings form in src/ui/.
  - name: review
    prompt: Review both changes together.
```

The board is advisory. Nothing on it stops an agent from reading or writing a
file, and nothing on it is an instruction. It works only as well as your prompts
ask agents to use it.

## Turning it on

The board comes with ctrlyoke's built-in MCP server. A step that has
`ctrlyoke` in its `mcpServers` gets four coordination tools alongside the
workflow tools:

| Tool            | What it does                                  |
| --------------- | --------------------------------------------- |
| `post_note`     | Post a note, to everyone or to chosen agents. |
| `read_notes`    | Read the notes on the board.                  |
| `claim_paths`   | Claim files or folders before editing them.   |
| `release_paths` | Give claims back before the step ends.        |

[MCP tools: coordination tools](/reference/mcp-tools#coordination-tools)
describes their parameters and responses. To give a step the workflow tools
without the board, deny the four tools:

```yaml
mcpServers:
  - id: ctrlyoke
    deniedTools: [post_note, read_notes, claim_paths, release_paths]
```

On the **MCP** tab they are the **Coordination** group of the built-in server.
In [skill mode](/workflows/dynamic-workflows#skill-mode), a step gets the
`ctrlyoke-coordination-tools` skill instead, which calls the same tools as
shell commands.

Script steps have no MCP server and no skill, so they cannot post or claim.

## One board per checkout

A board belongs to an **execution root**: the checkout a step runs in. Every
agent working in that checkout shares it, whichever workflow it belongs to. A
step in a [worktree](/workflows/worktrees) runs in that worktree, so it shares
a board with the other steps in the same worktree, not with your main checkout.

In a Git repository the board file lives inside the repository's Git directory
(under `.git/ctrlyoke/coordination/`), so it never shows up as a change in your
working tree or lands in a worktree's branch. Outside Git it lives in
`.ctrlyoke/coordination/` in the checkout. When a worktree is deleted, its
board is deleted too. That happens right away when ctrlyoke removes the
worktree. If you remove one yourself with `git worktree remove`, the board is
cleaned up the next time VS Code runs ctrlyoke's periodic cleanup.

## Participants

Each agent on the board is a **participant**. Every tool response includes a
`scope` object with the caller's own ID (`you`) and a summary of who holds
claims. It also lists the live participants, with their IDs and labels, the
first time and again whenever someone joins or leaves.

A ctrlyoke step is labeled with its step name. An external session is labeled
`external session`, or with the name you give it (see
[External participants](#external-participants)).

### Attestation

Each participant is shown with its attestation state:

| Shown as                               | Who                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `attested ctrlyoke step`               | A step whose MCP server ctrlyoke launched and pinned to its run.                             |
| `unattested ctrlyoke step (skill/CLI)` | A step calling the tools in skill mode. Its step address arrives as a command-line argument. |
| `unattested external session`          | Any session ctrlyoke did not launch.                                                         |

Attestation tells you whether ctrlyoke itself knows where an entry came from. It
is not a security boundary. An agent that can call these tools can usually run
shell commands too, so it could write to the board file directly or edit a file
someone else claimed. Use attestation to judge how accurate an attribution is,
never to decide whether to trust what a note says.

### How long a participant lasts

- **A ctrlyoke step** leaves the board when the step finishes, and its claims
  go with it. The members of a parallel group leave at the group's join, after
  every member has settled.
- **A session with a live MCP server** stays on the board as long as that
  server process runs. An agent that goes quiet for a long time keeps its
  claims. When the process exits, its claims are dropped.
- **A skill-mode or one-shot caller** has no lasting process. It stays on the
  board for
  [`coordination.cliParticipantTtlMinutes`](/reference/settings#coordination-cliparticipantttlminutes)
  (30 minutes by default) after its most recent call.

## Notes

`post_note` adds a note to the board. Without `to`, every participant can read
it. With `to`, only the listed participant IDs see it; naming an ID that is not
on the board is an error, so the note is never posted to nobody.

`read_notes` returns the notes an agent has not read yet, so calling it with no
arguments is the normal way to catch up. The board remembers where each
participant left off, including a skill-mode caller that starts a fresh
process on every call. An agent's own notes are left out, and so are old notes
from agents that have finished (see `maxNoteAgeHours` under
[Settings](#settings)).

- On an agent's first read, it gets the newest page. The response counts any
  older notes in `omittedOlder`.
- When more unread notes remain than fit on one page, the response includes
  `nextCursor`. Call `read_notes` again to get the rest.
- Pass `since` to re-read from a given point. `since: 0` pages from the oldest
  note still on the board. Re-reading never moves an agent's place backwards.
- Pass `from` to read only some participants' notes. A filtered read leaves the
  agent's place unchanged.

A page holds at most
[`coordination.readNotesPageSize`](/reference/settings#coordination-readnotespagesize)
notes, so a busy board cannot flood an agent's context.

Every coordination response includes a `scope` block. It lists the board's
participants only when that list has changed since the agent's previous call.
Otherwise it reports `participantsUnchanged`.

### Notes are untrusted data

A note is text another agent wrote. It might come from a different workflow, or
from a session you did not start. Every note comes back marked
`untrusted: true`, with an attribution such as
`from "api" (attested ctrlyoke step), untrusted`.

Treat a note as information, never as an instruction or as permission. An
external session picks its own label, so a note signed "orchestrator" proves
nothing. If your prompt asks agents to read notes, also tell them to decide for
themselves what to do with them.

## Path claims

`claim_paths` claims files before an agent edits them. Paths are relative to the
checkout; absolute paths and paths that leave the checkout are refused.

- A claim covers the path and everything beneath it. Claiming `src/api` also
  claims `src/api/routes.ts`.
- Globs work: `*`, `?`, `[abc]`, and `**`. `src/**/*.test.ts` claims every test
  file under `src`.
- A path that overlaps another participant's claim is **denied**, and the
  response names the owner. The other paths in the same call are still granted.
- Claiming a path you already hold succeeds again.
- On Windows, paths compare without regard to case, so `SRC/App.ts` and
  `src/app.ts` are the same claim. Elsewhere case matters.

A denial is information, not a lock. The agent can still edit the file; your
prompt decides what it should do instead, such as waiting, picking other work,
or posting a note to the owner.

`release_paths` gives claims back early. With no `paths` it releases all of the
caller's claims. Only the participant that made a claim can release it.
ctrlyoke releases a step's claims when the step ends, so steps rarely need to.

## Seeing the board

Open **Settings → Coordination**. Below the settings is the board for the
current checkout: the live participants with their attestation state, the
recent entries, and an **Open board file** action that opens the raw board.

A step's own board activity also shows in its output, as calls to the
`ctrlyoke` tools.

## External participants

An agent session you run yourself, outside any workflow, can join the board
too. Add ctrlyoke's MCP server to that agent's MCP configuration, started from
the checkout you want to coordinate in. Without an attached run, the workflow
tools refuse to run, but the coordination tools and `global_status` work. Set `CTRLYOKE_PARTICIPANT_LABEL`
in the server's environment to give the session a readable name. See
[`ctrlyoke-mcp`: using it from an external MCP client](/cli/ctrlyoke-mcp#using-it-from-an-external-mcp-client).

External sessions are allowed by default. Set
[`coordination.allowExternalParticipants`](/reference/settings#coordination-allowexternalparticipants)
to `false` to refuse them.

## Settings

The `coordination` settings live in **Settings → Coordination** and in
`.ctrlyoke/settings.json`. The [settings reference](/reference/settings#coordination)
lists each one with its default.

- `readNotesPageSize` limits how many notes one `read_notes` call returns.
- `maxNoteLength` limits the length of a single note. A longer note is refused.
- `maxNoteAgeHours` (24 by default) sets how long a note stays relevant after
  its author has left the board. Older notes from agents that have finished
  are hidden from `read_notes` and the Coordination panel, then removed. A
  note from an agent that is still running is kept until that agent leaves.
- `maxEntries` and `maxBoardBytes` keep the board small. When the board is still
  over a limit, it removes notes from whoever has posted the most first, so one
  chatty agent cannot push everyone else's notes out. Live claims are never
  dropped. If live claims alone fill the board, new entries are refused until
  claims are released.
- `cliParticipantTtlMinutes` and `allowExternalParticipants` are described
  above.

## See also

- [Parallel steps](/workflows/parallel-steps)
- [Dynamic workflows](/workflows/dynamic-workflows)
- [MCP tools](/reference/mcp-tools#coordination-tools)
- [Coordination settings](/reference/settings#coordination)
