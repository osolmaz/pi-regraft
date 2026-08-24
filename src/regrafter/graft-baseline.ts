import { join } from "node:path";
import { findLocalBaseCommit, git } from "../git.js";
import { MANIFEST_FILE, readManifest } from "../manifest.js";
import type { GraftBaseline } from "./types.js";

export async function captureGraftBaseline(
  repository: string,
  startingHead: string
): Promise<GraftBaseline> {
  const manifest = await readManifest(join(repository, MANIFEST_FILE));
  const grafts = await Promise.all(
    manifest.grafts.map(async (graft) => {
      const localBase = await findLocalBaseCommit(
        repository,
        MANIFEST_FILE,
        graft.name,
        graft.dest,
        graft.commit
      );
      const difference = await git(
        ["--literal-pathspecs", "diff", "--quiet", localBase, startingHead, "--", graft.dest],
        repository
      );
      if (difference.code !== 0 && difference.code !== 1) {
        throw new Error(
          `could not compare local overlay for graft "${graft.name}": ${difference.stderr.trim() || difference.stdout.trim()}`
        );
      }
      return {
        graft: graft.name,
        dest: graft.dest,
        upstream: graft.commit,
        local_base: localBase,
        local_overlay: difference.code === 1
      };
    })
  );
  return { starting_head: startingHead, grafts };
}
