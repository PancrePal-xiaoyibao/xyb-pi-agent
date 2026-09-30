import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fail when an electron-updater feed advertises a file that is not next to it.
 *
 * Why this gate exists: electron-builder rewrites a feed's `url` and `path` to a
 * fallback built from the scoped npm name — `${name}-${version}-${arch}.${ext}` —
 * whenever the artifact name it produced is not a safe GitHub asset name
 * (`app-builder-lib/out/platformPackager.js` `computeSafeArtifactNameIfNeeded`;
 * `out/publish/updateInfoBuilder.js` applies the result only for the GitHub
 * provider). The artifact itself keeps the name electron-builder wrote, so the
 * feed and the released asset can disagree and nothing upstream notices.
 *
 * v0.16.0 shipped exactly that: the AppImage had no explicit pattern, so it was
 * built as `小胰宝-0.16.0.AppImage`, GitHub stored the asset as
 * `-0.16.0.AppImage`, and `latest-linux.yml` advertised
 * `@pi-desktop/desktop-0.16.0-x86_64.AppImage`. Every AppImage updater request
 * 404s, and the release still reported success because no step compared the two.
 *
 * The check is deliberately one-directional (feed -> file). Blockmaps, the Linux
 * ASAR, and the pi-host bundle are legitimately absent from every feed.
 */

const FEED_PATTERN = /^latest.*\.ya?ml$/;

/**
 * Collect the file names a feed points at: `url` inside each `files:` entry, plus
 * the top-level `path` that older updaters follow. Values are plain scalars.
 */
export function parseFeedReferences(feedText) {
  const references = [];
  for (const line of feedText.split(/\r?\n/)) {
    const match = /^\s*(?:-\s*)?(?:url|path):\s*(\S.*?)\s*$/.exec(line);
    if (match === null) {
      continue;
    }
    references.push(match[1].replace(/^(['"])(.*)\1$/, "$2"));
  }
  return references;
}

/**
 * A reference may be percent-encoded; a URL client (electron-updater) decodes it
 * before requesting the asset, so accept either form.
 */
function resolves(reference, available) {
  if (available.has(reference)) {
    return true;
  }
  try {
    return available.has(decodeURIComponent(reference));
  } catch {
    return false;
  }
}

export async function checkReleaseFeeds({ dir = "dist" } = {}) {
  const directory = resolve(dir);
  const entries = await readdir(directory).catch(() => null);
  if (entries === null) {
    throw new Error(`release directory does not exist: ${directory}`);
  }

  const feeds = entries.filter((name) => FEED_PATTERN.test(name)).sort();
  if (feeds.length === 0) {
    throw new Error(
      `no updater feed (latest*.yml) in ${directory}; the release would ship without update metadata`,
    );
  }

  const available = new Set(entries);
  const checked = [];
  const missing = [];
  for (const feed of feeds) {
    // A name appears both in its `files:` entry and in the top-level `path`;
    // report each distinct reference once.
    const references = new Set(
      parseFeedReferences(await readFile(join(directory, feed), "utf8")),
    );
    for (const reference of references) {
      checked.push({ feed, reference });
      if (!resolves(reference, available)) {
        missing.push({ feed, reference });
      }
    }
  }

  return { directory, feeds, checked, missing };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkReleaseFeeds({ dir: process.argv[2] ?? "dist" });
    for (const feed of result.feeds) {
      const count = result.checked.filter((entry) => entry.feed === feed).length;
      console.log(`${feed}: ${count} referenced artifact(s)`);
    }
    if (result.missing.length > 0) {
      for (const entry of result.missing) {
        // Workflow annotations are parsed from stdout.
        console.log(
          `::error::${entry.feed} references ${entry.reference}, which does not exist in ${result.directory}`,
        );
      }
      console.error(
        `${result.missing.length} updater feed reference(s) would 404 for installed apps.`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        `All updater feed references resolve inside ${result.directory}.`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
