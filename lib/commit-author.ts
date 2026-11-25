// Who the factory's commits name as author and committer. GitHub and Vercel tie a commit to an
// account by its email, and a noreply address resolves only in GitHub's <id>+<login> form.

export const COMMIT_NAME = "marshal-factory";

export type CommitAuthor = { name: string; email: string };
export type GhUser = { id: number; login: string };

const NOREPLY = /@users\.noreply\.github\.com$/i;
const ACCOUNT_NOREPLY = /^\d+\+[A-Za-z0-9-]+@users\.noreply\.github\.com$/i;

/** GitHub's noreply address for the account. */
export const noreplyEmail = (user: GhUser) => `${user.id}+${user.login}@users.noreply.github.com`;

const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!;

/**
 * The configured email, else the noreply address of the account gh is logged in as. Throws rather
 * than fall back, since a commit with an address no account owns fails Vercel's deploy check.
 */
export async function resolveCommitAuthor(configured: string | undefined, ghUser: () => Promise<GhUser>): Promise<CommitAuthor> {
  let email = configured;
  if (!email) {
    try {
      email = noreplyEmail(await ghUser());
    } catch (error) {
      throw new Error(
        `No commit author email: set factory.commitEmail in the factory config, or log gh in (gh auth login) so the runner can use <id>+<login>@users.noreply.github.com. gh api user failed: ${firstLine(error)}`,
      );
    }
  }
  if (NOREPLY.test(email) && !ACCOUNT_NOREPLY.test(email)) {
    throw new Error(`The commit author email ${email} is a GitHub noreply address no account owns; use the <id>+<login>@users.noreply.github.com form.`);
  }
  return { name: COMMIT_NAME, email };
}

/** git -c flags that make one command commit as the author. */
export const identityArgs = (author: CommitAuthor) => ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`];
