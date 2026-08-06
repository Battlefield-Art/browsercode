// Serve-only entrypoint for the `bcode-<target>-serve` binary variant (ENG-5671).
//
// `packages/opencode/src/index.ts` eagerly imports all 24 command modules before
// yargs parses. The headless V4 runtime only ever invokes `bcode serve`, so the
// other 23 — TUI, run, web, github, pr, stats, import/export, db — are dead
// weight in its binary. They cost little at boot (the serve module graph already
// pulls the expensive shared core), but they cost real bytes, and bytes decide
// whether bytecode compilation is affordable:
//
//   entrypoint         plain              bytecode
//   opencode index.ts  108 MB / 412 ms    310 MB / 266 ms
//   this file           92 MB / 381 ms    229 MB / 257 ms
//
// (darwin-arm64, no embedded web UI, spawn-to-listening-banner, medians of 7.)
// Excluding the unused commands saves 16 MB without bytecode but 81 MB with it —
// dead code is ~5x more expensive once every function also carries compiled
// bytecode.
//
// This package exists so none of that touches `packages/opencode`, which is
// forked from upstream and synced regularly. Everything here is additive: a new
// package, a new release asset, and an opt-in installer flag. The standard
// binary is built and published exactly as before.
//
// DRIFT WARNING: the global-option and lifecycle wiring below is duplicated from
// `packages/opencode/src/index.ts`, which stays the source of truth. Global
// options added there must be mirrored here. The build script's smoke test boots
// `serve` for real (not just `--version`) so that a missing build-time `define`
// or a broken module graph fails the build rather than the deployment.

// Telemetry key injection runs as an import side effect of this module, before
// any subsequent import is evaluated. Keep this as the FIRST import so the
// LMNR_PROJECT_API_KEY env var is settled before any downstream module-load code
// reads it. (Same ordering contract as packages/opencode/src/index.ts.)
import "@browser-use/bcode-browser/telemetry"

import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { EOL } from "os"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ServeCommand } from "@browser-use/browsercode-core/cli/cmd/serve"
import { UI } from "@browser-use/browsercode-core/cli/ui"
import { FormatError } from "@browser-use/browsercode-core/cli/error"
import { errorMessage } from "@browser-use/browsercode-core/util/error"
import { Heap } from "@browser-use/browsercode-core/cli/heap"

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("bcode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("bcode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)
  })
  .usage("")
  .command(ServeCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Plugin shutdown hooks are the single drain point for OTel-based plugins
  // (e.g. bcode-laminar) — without this the V4 worker loses trailing spans.
  // Mirrors the drain in packages/opencode/src/index.ts; see the note there for
  // why the host-side forceFlush fallback was dropped.
  try {
    const { pluginShutdownHooks } = await import("@browser-use/browsercode-core/plugin/index")
    await Promise.race([
      Promise.allSettled(
        Array.from(pluginShutdownHooks).map((hook) =>
          Promise.resolve()
            .then(hook)
            .catch((err: Error) => console.error("plugin shutdown hook failed", err)),
        ),
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ])
  } catch (err) {
    console.error("plugin shutdown import failed", err)
  }
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
