/** Longest slug in a runner branch name. */
export const SLUG_MAX_LENGTH = 40;

/**
 * A title as a branch-name fragment: lower-cased, every run of non-alphanumerics one `-`,
 * no leading or trailing `-`, at most forty characters. May be empty.
 */
export function slug(title: string): string {
  const collapsed = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return collapsed.slice(0, SLUG_MAX_LENGTH).replace(/-$/, "");
}

/** `skelcrew/<id>-<slug>`, or `skelcrew/<id>` when the title leaves no slug. */
export function branchName(id: number, title: string): string {
  const fragment = slug(title);
  return fragment.length === 0 ? `skelcrew/${id}` : `skelcrew/${id}-${fragment}`;
}
