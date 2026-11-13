/** Convert a worktree name to the bounded directory slug used by ctrlyoke. */
export function slugifyWorktreeName(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase();
  const slug = ascii.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (slug || "workflow").slice(0, 40).replace(/-+$/g, "") || "workflow";
}
