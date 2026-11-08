import { z } from "zod";
import { inTestMode } from "./test-mode";

// The name and email on every commit the factory makes: an agent's in a sandbox, a revert on this
// machine. Hosts such as Vercel refuse a commit whose author email is no real address, and GitHub
// links one to an account only by an address that account owns, so the email comes from the config
// or from the gh login, never from a made-up default. A local thread commits as this machine's own
// git config, in the owner's checkout, which the factory leaves alone.

export type CommitIdentity = { name: string; email: string };

/** GitHub's noreply addresses resolve to an account only in the `<id>+<login>@` form. */
const NOREPLY = /@users\.noreply\.github\.com$/i;
const ACCOUNT_NOREPLY = /^\d+\+[A-Za-z0-9-]+@users\.noreply\.github\.com$/i;

/** Why `email` cannot author factory commits, or null when it can. */
export function emailProblem(email: string) {
  if (!z.email().safeParse(email).success) return `${JSON.stringify(email)} is not an email address`;
  if (NOREPLY.test(email) && !ACCOUNT_NOREPLY.test(email)) {
    return `${email} is a GitHub noreply address without an account id; use <id>+<login>@users.noreply.github.com`;
  }
  return null;
}

export const commitAuthorSchema = z
  .object({
    name: z.string().min(1).default("marshal-factory"),
    /** Absent: the runner derives <id>+<login>@users.noreply.github.com from the gh login at start-up. */
    email: z
      .string()
      .refine((email) => emailProblem(email) === null, { error: (issue) => emailProblem(String(issue.input)) ?? "invalid email" })
      .optional(),
  })
  .prefault({});
export type CommitAuthor = z.infer<typeof commitAuthorSchema>;

export const noreplyEmail = (id: number, login: string) => `${id}+${login}@users.noreply.github.com`;

const ghUserSchema = z.object({ id: z.number().int().positive(), login: z.string().min(1) });
export type GhUser = z.infer<typeof ghUserSchema>;

/**
 * The configured email, else the gh account's noreply address. Throws, naming the setting, when
 * neither gives a usable address; the runner must not commit as anyone else.
 */
export async function resolveCommitIdentity(author: CommitAuthor, ghUser: () => Promise<unknown>): Promise<CommitIdentity> {
  if (author.email) return { name: author.name, email: author.email };
  let user: GhUser;
  try {
    user = ghUserSchema.parse(await ghUser());
  } catch (error) {
    const why = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    throw new Error(
      `No commit author email: factory.commitAuthor.email is not set in the config, and the logged-in gh account could not be read (${why}). ` +
        "Run `gh auth login`, or set factory.commitAuthor.email to an address GitHub links to your account.",
    );
  }
  const email = noreplyEmail(user.id, user.login);
  const problem = emailProblem(email);
  if (problem) throw new Error(`No commit author email: the gh account gives ${problem}. Set factory.commitAuthor.email.`);
  return { name: author.name, email };
}

/** A regression run's identity, so code under test can commit without a gh login. */
export const TEST_COMMIT_IDENTITY: CommitIdentity = { name: "marshal-factory", email: "1+factory-test@users.noreply.github.com" };

let resolved: CommitIdentity | undefined;

export function setCommitIdentity(identity: CommitIdentity | undefined) {
  resolved = identity;
}

/** The identity the runner resolved at start-up; throws when it has not, rather than commit without one. */
export function commitIdentity(): CommitIdentity {
  if (resolved) return resolved;
  if (inTestMode()) return TEST_COMMIT_IDENTITY;
  throw new Error("The runner has not resolved its commit author; resolveCommitIdentity runs at start-up.");
}
