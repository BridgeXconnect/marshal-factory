import { z } from "zod";
import { resolveCommitAuthor, type CommitAuthor } from "../lib/commit-author";
import { localHost } from "../lib/host";
import { config } from "./config";

/** Where the runner looks up the gh account; regressions replace it. */
export const commitAuthorRuntime = {
  ghUser: async () =>
    z.object({ id: z.number().int(), login: z.string().min(1) }).parse(JSON.parse((await localHost.run("gh", ["api", "user"], { timeoutMs: 30_000 })).stdout)),
};

let resolved: Promise<CommitAuthor> | undefined;

/** Resolved once; the runner awaits it at start-up, so a missing email stops it there and not mid-job. */
export const commitAuthor = () => (resolved ??= resolveCommitAuthor(config.factory.commitEmail, commitAuthorRuntime.ghUser));
