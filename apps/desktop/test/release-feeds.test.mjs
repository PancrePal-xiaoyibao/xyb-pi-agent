import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkReleaseFeeds,
  parseFeedReferences,
} from "../../../scripts/check-release-feeds.mjs";

/**
 * These fixtures mirror the real v0.16.0 release, where the AppImage lane had no
 * explicit `artifactName`: electron-builder wrote `小胰宝-0.16.0.AppImage`, GitHub
 * stored the asset as `-0.16.0.AppImage`, and `latest-linux.yml` advertised
 * `@pi-desktop/desktop-0.16.0-x86_64.AppImage` — a URL that 404s for every
 * installed AppImage.
 */
const BROKEN_APPIMAGE = "'@pi-desktop/desktop-0.16.0-x86_64.AppImage'";

const WINDOWS_FEED = `version: 0.16.0
files:
  - url: xiaoyibao-Setup-0.16.0.exe
    sha512: YWJj
    size: 104635049
path: xiaoyibao-Setup-0.16.0.exe
sha512: YWJj
releaseDate: '2026-09-30T08:16:51.348Z'
`;

function linuxFeed(files, path) {
  const entries = files
    .map((name) => `  - url: ${name}\n    sha512: YWJj\n    size: 1`)
    .join("\n");
  return `version: 0.16.0
files:
${entries}
path: ${path}
sha512: YWJj
releaseDate: '2026-09-30T08:16:51.348Z'
`;
}

// ruby's to_yaml, which the macOS merge step uses, puts the dash in column 0.
const MAC_FEED_MERGED = `---
version: 0.16.0
files:
- url: xiaoyibao-0.16.0-arm64-mac.zip
  sha512: YWJj
  size: 1
- url: xiaoyibao-0.16.0-x64-mac.zip
  sha512: ZGVm
  size: 1
path: xiaoyibao-0.16.0-arm64-mac.zip
sha512: YWJj
releaseDate: '2026-09-30T08:16:51.348Z'
`;

async function makeRelease(files, feeds) {
  const root = await mkdtemp(join(tmpdir(), "pi-release-feeds-"));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(root, name), contents);
  }
  for (const [name, contents] of Object.entries(feeds)) {
    await writeFile(join(root, name), contents);
  }
  return root;
}

test("feed references cover file entries and the top-level path only", () => {
  assert.deepEqual(parseFeedReferences(WINDOWS_FEED), [
    "xiaoyibao-Setup-0.16.0.exe",
    "xiaoyibao-Setup-0.16.0.exe",
  ]);
  assert.deepEqual(
    parseFeedReferences(
      linuxFeed([BROKEN_APPIMAGE, "xiaoyibao_0.16.0_amd64.deb"], BROKEN_APPIMAGE),
    ),
    [
      "@pi-desktop/desktop-0.16.0-x86_64.AppImage",
      "xiaoyibao_0.16.0_amd64.deb",
      "@pi-desktop/desktop-0.16.0-x86_64.AppImage",
    ],
    "quotes are stripped, sha512/size/releaseDate are not references",
  );
  assert.deepEqual(parseFeedReferences(MAC_FEED_MERGED), [
    "xiaoyibao-0.16.0-arm64-mac.zip",
    "xiaoyibao-0.16.0-x64-mac.zip",
    "xiaoyibao-0.16.0-arm64-mac.zip",
  ]);
});

test("a feed that advertises a name the release does not carry is rejected", async (t) => {
  const root = await makeRelease(
    {
      "小胰宝-0.16.0.AppImage": "appimage",
      "xiaoyibao_0.16.0_amd64.deb": "deb",
      "xiaoyibao-Setup-0.16.0.exe": "exe",
    },
    {
      "latest.yml": WINDOWS_FEED,
      "latest-linux.yml": linuxFeed(
        [BROKEN_APPIMAGE, "xiaoyibao_0.16.0_amd64.deb"],
        BROKEN_APPIMAGE,
      ),
    },
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await checkReleaseFeeds({ dir: root });

  assert.deepEqual(
    result.missing,
    [
      {
        feed: "latest-linux.yml",
        reference: "@pi-desktop/desktop-0.16.0-x86_64.AppImage",
      },
    ],
    "only the AppImage reference is missing; the deb and exe resolve",
  );
});

test("a renamed top-level path is rejected even when every file entry resolves", async (t) => {
  const root = await makeRelease(
    {
      "xiaoyibao-0.16.0-x86_64.AppImage": "appimage",
      "xiaoyibao_0.16.0_amd64.deb": "deb",
    },
    {
      "latest-linux.yml": linuxFeed(
        ["xiaoyibao-0.16.0-x86_64.AppImage", "xiaoyibao_0.16.0_amd64.deb"],
        "stale-name.AppImage",
      ),
    },
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await checkReleaseFeeds({ dir: root });

  assert.deepEqual(
    result.missing.map((entry) => entry.reference),
    ["stale-name.AppImage"],
  );
});

test("feeds whose references all exist pass, including the merged macOS feed", async (t) => {
  const root = await makeRelease(
    {
      "xiaoyibao-Setup-0.16.0.exe": "exe",
      "xiaoyibao-0.16.0-x86_64.AppImage": "appimage",
      "xiaoyibao_0.16.0_amd64.deb": "deb",
      "xiaoyibao-0.16.0-arm64-mac.zip": "zip",
      "xiaoyibao-0.16.0-x64-mac.zip": "zip",
      "xiaoyibao-0.16.0-linux-x64.asar": "asar",
      "pi-host-0.16.0-linux-x64.tar.gz": "tar",
    },
    {
      "latest.yml": WINDOWS_FEED,
      "latest-linux.yml": linuxFeed(
        ["xiaoyibao-0.16.0-x86_64.AppImage", "xiaoyibao_0.16.0_amd64.deb"],
        "xiaoyibao-0.16.0-x86_64.AppImage",
      ),
      "latest-mac.yml": MAC_FEED_MERGED,
    },
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await checkReleaseFeeds({ dir: root });

  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.feeds, [
    "latest-linux.yml",
    "latest-mac.yml",
    "latest.yml",
  ]);
  // Artifacts nothing points at are fine: no feed carries them.
  for (const name of [
    "xiaoyibao-0.16.0-linux-x64.asar",
    "pi-host-0.16.0-linux-x64.tar.gz",
  ]) {
    assert.ok(
      !result.checked.some((entry) => entry.reference === name),
      `${name} is not an updater artifact`,
    );
  }
});

test("a release with no updater feed is an error", async (t) => {
  const root = await makeRelease({ "xiaoyibao-Setup-0.16.0.exe": "exe" }, {});
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(() => checkReleaseFeeds({ dir: root }), /no updater feed/);
});
