const { execSync } = require("child_process");

/**
 * Build stamp so a running instance can prove which code it is serving.
 * Next.js only inlines NEXT_PUBLIC_* at build time, so this is baked into
 * the bundle — which is exactly the point.
 */
function buildId() {
  try {
    const sha = execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (sha) {
      // Two builds of the same commit are indistinguishable by SHA alone, which
      // is exactly the confusion this stamp exists to prevent.
      let dirty = "";
      try {
        dirty = execSync("git status --porcelain", {
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim();
      } catch {
        // ignore
      }
      return dirty ? `${sha}-dirty` : sha;
    }
  } catch {
    // Not a git checkout (e.g. CI artifact) — fall through.
  }
  return "dev";
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_BUILD_ID: buildId(),
  },
};

module.exports = nextConfig;
