#!/usr/bin/env bash
#
# BrowserCode installer — bytecode / serve-only build.
#
# Hosted at https://bcode.sh/bytecode, alongside (not replacing)
# https://bcode.sh/install:
#
#   curl -fsSL https://bcode.sh/bytecode | bash -s -- --no-modify-path --version 0.0.3
#
# Installs the `bcode-linux-<arch>-serve` asset, which provides ONLY
# `bcode serve` — `run`, `tui`, `web`, `github` and the rest are absent and
# exit 1. It exists for headless containers; anyone installing bcode on a
# laptop wants https://bcode.sh/install.
#
# `install.sh` is the published path docs point at and stays untouched. This is
# additive: a second script, a second URL, a second release asset.
#
# Linux only. Deliberately much shorter than install.sh: one build per arch (no
# baseline/AVX2 detection), no shell-rc editing (containers set PATH in the
# Dockerfile), no uv hint. Takes install.sh's flags so switching is a one-word
# change to the URL in a Dockerfile.
set -euo pipefail

APP=bcode
VARIANT=serve
REPO=browser-use/browsercode

MUTED='\033[0;2m'
RED='\033[0;31m'
ORANGE='\033[38;5;214m'
NC='\033[0m'

usage() {
    cat <<EOF
BrowserCode Installer (bytecode / serve-only build)

Usage: install-bytecode.sh [options]

Installs a bcode binary that provides ONLY 'bcode serve'. For the full CLI use
https://bcode.sh/install instead.

Options:
    -h, --help              Display this help message
    -v, --version <version> Install a specific version (e.g. 0.0.3)
        --install-dir <dir> Install to <dir> (default: \$HOME/.bcode/bin)
        --no-modify-path    Accepted for parity with install.sh; this script
                            never edits shell config files.

Examples:
    curl -fsSL https://bcode.sh/bytecode | bash
    curl -fsSL https://bcode.sh/bytecode | bash -s -- --no-modify-path --version 0.0.3
EOF
}

requested_version=${VERSION:-}
install_dir=${BCODE_INSTALL_DIR:-$HOME/.bcode/bin}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        -v|--version)
            if [[ -n "${2:-}" ]]; then
                requested_version="$2"
                shift 2
            else
                echo -e "${RED}Error: --version requires a version argument${NC}" >&2
                exit 1
            fi
            ;;
        --install-dir)
            if [[ -n "${2:-}" ]]; then
                install_dir="$2"
                shift 2
            else
                echo -e "${RED}Error: --install-dir requires a path argument${NC}" >&2
                exit 1
            fi
            ;;
        --no-modify-path)
            # No-op: this script never touches shell config. Accepted so an
            # existing install.sh invocation works verbatim against this URL.
            shift
            ;;
        *)
            echo -e "${ORANGE}Warning: Unknown option '$1'${NC}" >&2
            shift
            ;;
    esac
done

raw_os=$(uname -s)
case "$raw_os" in
  Linux*) os="linux" ;;
  *)
    echo -e "${RED}Error: the ${VARIANT} build is published for linux only (detected: ${raw_os}).${NC}" >&2
    echo -e "${MUTED}Use https://bcode.sh/install for the standard cross-platform binary.${NC}" >&2
    exit 1
    ;;
esac

arch=$(uname -m)
case "$arch" in
  aarch64|arm64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *)
    echo -e "${RED}Error: unsupported architecture '${arch}'. Supported: arm64, x64.${NC}" >&2
    exit 1
    ;;
esac

for tool in curl tar; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo -e "${RED}Error: '${tool}' is required but not installed.${NC}" >&2
        exit 1
    fi
done

# A glibc binary will not start on musl, so pick the matching build rather than
# installing something that dies at exec.
is_musl=false
if [ -f /etc/alpine-release ]; then
    is_musl=true
elif command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
    is_musl=true
fi

# Non-baseline x64 builds require AVX2. This variant publishes no baseline
# asset, so say that rather than installing a binary that SIGILLs on first run.
# (Adding it is one entry in packages/bcode-serve/script/build.ts if ever needed.)
# Only trip when /proc/cpuinfo is actually readable — unknown is not "absent".
if [ "$arch" = "x64" ] && [ -r /proc/cpuinfo ] && ! grep -qwi avx2 /proc/cpuinfo; then
    echo -e "${RED}Error: this CPU lacks AVX2, and no baseline ${VARIANT} build is published.${NC}" >&2
    echo -e "${MUTED}Use https://bcode.sh/install, which ships a baseline binary.${NC}" >&2
    exit 1
fi

target="${os}-${arch}"
[ "$is_musl" = true ] && target="${target}-musl"
filename="${APP}-${target}-${VARIANT}.tar.gz"

if [ -z "$requested_version" ]; then
    url="https://github.com/${REPO}/releases/latest/download/${filename}"
    specific_version=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
        | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' || true)
    if [ -z "$specific_version" ]; then
        echo -e "${RED}Failed to resolve the latest version.${NC}" >&2
        echo -e "${MUTED}If the repo is private, pin a version: --version <ver>${NC}" >&2
        exit 1
    fi
else
    specific_version="${requested_version#v}"
    url="https://github.com/${REPO}/releases/download/v${specific_version}/${filename}"
fi

echo -e "${MUTED}Installing ${NC}${APP} ${MUTED}(${VARIANT} build) version: ${NC}${specific_version}"

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/bcode_bytecode_install.XXXXXX")
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

# Fail loudly rather than unpacking a 404 body. Releases predating this variant
# legitimately lack the asset, so say that instead of erroring out of tar.
if ! curl -fsSL -o "${tmp_dir}/${filename}" "$url"; then
    echo -e "${RED}Error: could not download ${filename} for v${specific_version}.${NC}" >&2
    echo -e "${MUTED}URL: ${url}${NC}" >&2
    echo -e "${MUTED}Releases predating the ${VARIANT} variant do not publish this asset.${NC}" >&2
    echo -e "${MUTED}Check https://github.com/${REPO}/releases for one that does, or use https://bcode.sh/install.${NC}" >&2
    exit 1
fi

tar -xzf "${tmp_dir}/${filename}" -C "$tmp_dir"

if [ ! -f "${tmp_dir}/${APP}" ]; then
    echo -e "${RED}Error: archive did not contain a '${APP}' binary.${NC}" >&2
    exit 1
fi

# Validate before installing, not after: a corrupt or wrong-libc download that
# fails here must not have already overwritten a working bcode.
chmod 755 "${tmp_dir}/${APP}"
if ! installed_version=$("${tmp_dir}/${APP}" --version 2>/dev/null); then
    echo -e "${RED}Error: downloaded binary failed to run; leaving any existing install untouched.${NC}" >&2
    exit 1
fi

mkdir -p "$install_dir"
mv "${tmp_dir}/${APP}" "${install_dir}/${APP}"
chmod 755 "${install_dir}/${APP}"

echo -e "${MUTED}Installed ${NC}${install_dir}/${APP}${MUTED} (${installed_version})${NC}"
echo -e "${MUTED}This build provides '${APP} serve' only.${NC}"
