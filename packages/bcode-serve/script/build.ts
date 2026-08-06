#!/usr/bin/env bun
//
// Builds the `bcode-<target>-serve` binary variant (ENG-5671).
//
// Deliberately separate from `packages/opencode/script/build.ts`: that package
// is forked from upstream and synced regularly, so it stays byte-for-byte
// untouched. This script produces an *additional* release asset and never
// writes to the standard one — different dist dir, different asset name.
//
// Differences from the standard build:
//   - entrypoint is this package's serve-only `src/index.ts` (1 command, not 24)
//   - no embedded web UI (headless; `embeddedUI()` already handles its absence)
//   - no TUI worker entrypoint (reachable only from `cli/cmd/tui.ts`)
//   - `bytecode: true` — skips JS parse at boot, ~-33% spawn-to-listening
//   - linux only by default; the only consumer is the container image
//
// The Bun.build config below mirrors the standard build's. It has to be kept in
// sync by hand — the alternative is editing the upstream file, which is what
// this package exists to avoid. The smoke test boots `serve` for real, so a
// missing `define` or a broken graph fails here rather than in production.
//
// Usage:
//   bun run script/build.ts                          # host target, no upload
//   bun run script/build.ts --targets linux-arm64     # cross-compile
//   OPENCODE_RELEASE=1 bun run script/build.ts ...    # archive + gh upload

import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const opencodeDir = path.resolve(dir, "../opencode")

// `generate.ts` chdirs into packages/opencode as an import side effect; restore
// ours afterwards so the skills bundle's relative specifiers resolve correctly.
const generated = await import(path.join(opencodeDir, "script/generate.ts"))
process.chdir(dir)

import { Script } from "@opencode-ai/script"
import { createEmbeddedSkillsBundle } from "../../bcode-browser/script/embed-skills.ts"
import opencodePkg from "../../opencode/package.json"

const skipInstall = process.argv.includes("--skip-install")
const noBytecodeFlag = process.argv.includes("--no-bytecode")

// Target allowlist, matched against `<os>-<arch>[-baseline][-musl]`. Defaults to
// the host target so a local `bun run build` is quick; release CI passes linux.
const targetsArg = process.argv.includes("--targets")
  ? process.argv[process.argv.indexOf("--targets") + 1]
  : process.env.BCODE_SERVE_TARGETS

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
]

const targetSuffixFor = (item: (typeof allTargets)[number]) =>
  [item.os, item.arch, item.avx2 === false ? "baseline" : undefined, item.abi]
    .filter(Boolean)
    .join("-")

const targets = targetsArg
  ? (() => {
      const wanted = new Set(
        targetsArg
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      )
      const matched = allTargets.filter((item) => wanted.has(targetSuffixFor(item)))
      if (matched.length === 0) {
        console.error(
          `No targets matched --targets ${targetsArg}. Known: ${allTargets.map(targetSuffixFor).join(", ")}`,
        )
        process.exit(1)
      }
      return matched
    })()
  : allTargets.filter((item) => item.os === process.platform && item.arch === process.arch && !item.abi)

const embeddedSkillsFileMap = await createEmbeddedSkillsBundle(dir)

await $`rm -rf dist`

if (!skipInstall) {
  // Cross-compiling needs the other platforms' native artifacts present.
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${opencodePkg.dependencies["@ff-labs/fff-bun"]}`.cwd(
    opencodeDir,
  )
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${opencodePkg.dependencies["@parcel/watcher"]}`.cwd(
    opencodeDir,
  )
}

const archives: string[] = []

for (const item of targets) {
  const targetSuffix = targetSuffixFor(item)
  const assetName = `bcode-${targetSuffix}-serve` // release archive basename
  const outdir = `dist/${assetName}`
  console.log(`building ${assetName}`)
  await $`mkdir -p ${outdir}/bin`

  const skillsPath = "bcode-skills.gen.ts"

  const result = await Bun.build({
    conditions: ["bun", "node"],
    // The opencode tsconfig supplies the `@/*` -> packages/opencode/src/*
    // path mapping that its own sources rely on.
    tsconfig: path.join(opencodeDir, "tsconfig.json"),
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: "none",
    splitting: true,
    bytecode: !noBytecodeFlag,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: `bun-${targetSuffix}` as any,
      outfile: path.join(dir, outdir, "bin/bcode"),
      execArgv: [`--user-agent=opencode/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: {
      [skillsPath]: embeddedSkillsFileMap,
    },
    entrypoints: ["./src/index.ts", skillsPath],
    define: {
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_MODELS_DEV: generated.modelsData,
      // TUI-only, but referenced behind a `typeof` guard in opencode sources —
      // define it so a stray reference cannot throw ReferenceError.
      OTUI_TREE_SITTER_WORKER_PATH: `''`,
      OPENCODE_WORKER_PATH: `''`,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      // Build-time-embedded Laminar project key. Populated by release CI from
      // the LMNR_PROJECT_API_KEY_OSS secret; empty for local builds. Runtime use
      // is gated in @browser-use/bcode-browser/src/telemetry.ts.
      BCODE_DEFAULT_LMNR_KEY: JSON.stringify(process.env.BCODE_DEFAULT_LMNR_KEY ?? ""),
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })
  if (!result.success) {
    console.error(result.logs)
    process.exit(1)
  }

  // Smoke test: boot the server for real, not just `--version`. A missing
  // `define` or a module dropped from the graph shows up as a failure to reach
  // the listening banner, which `--version` would sail straight past.
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = path.join(dir, outdir, "bin/bcode")
    console.log(`Smoke test: ${assetName} serve`)
    const proc = Bun.spawn([binaryPath, "serve", "--port", "0", "--hostname", "127.0.0.1"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: "smoke-test" },
    })
    const listening = (async () => {
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      let buffered = ""
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffered += decoder.decode(value, { stream: true })
        if (buffered.includes("listening on")) return buffered
      }
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`server exited before listening.\nstdout:\n${buffered}\nstderr:\n${stderr}`)
    })()
    try {
      const banner = await Promise.race([
        listening,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out after 30s")), 30_000)),
      ])
      console.log(`Smoke test passed: ${banner.trim().split("\n").at(-1)}`)
    } catch (e) {
      console.error(`Smoke test failed for ${assetName}:`, e)
      proc.kill()
      process.exit(1)
    } finally {
      proc.kill()
      await proc.exited
    }
  }

  if (Script.release) {
    // linux only, so tar for everything; add a zip branch if darwin ships.
    await $`tar -czf ../../${assetName}.tar.gz *`.cwd(`${outdir}/bin`)
    archives.push(`./dist/${assetName}.tar.gz`)
  }
}

if (Script.release) {
  await $`gh release upload v${Script.version} ${archives} --clobber --repo ${process.env.GH_REPO}`
  console.log(`uploaded: ${archives.join(", ")}`)
}
