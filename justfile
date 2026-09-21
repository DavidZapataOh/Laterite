# Laterite build automation
# https://github.com/casey/just

set shell := ["bash", "-uc"]
set dotenv-load

program_dir := "programs/laterite"

# List available recipes
default:
    @just --list

# ============================================
# Setup
# ============================================

# Check the toolchain, install dependencies and configure git hooks
setup: setup-hooks
    #!/usr/bin/env bash
    set -euo pipefail
    for cmd in pnpm cargo solana anchor surfpool; do
        if ! command -v "$cmd" &>/dev/null; then
            echo "Error: $cmd is required but not installed"
            exit 1
        fi
    done
    pnpm install --frozen-lockfile
    echo "✓ Setup complete"

# Point git at the repository hooks
setup-hooks:
    git config core.hooksPath .githooks
    @echo "✓ Git hooks configured"

# Print the program ID declared in the program source
program-id:
    @sed -n 's/.*declare_id!("\([^"]*\)").*/\1/p' "{{program_dir}}/src/lib.rs"

# ============================================
# Build
# ============================================

# Build everything
build: build-program build-landing

# Compile the program to SBF
build-program:
    anchor build --ignore-keys
    @echo "✓ Program built"

# Build the landing page
build-landing:
    pnpm --filter @laterite/landing build
    @echo "✓ Landing built"

# ============================================
# Test
# ============================================

# Run every suite CI runs
test: unit-test

# Run the program tests against the built binary
unit-test: build-program
    cargo test -p laterite

# Compare the landing with its screenshot baseline (macOS baselines, local only)
test-visual: build-landing
    pnpm --filter @laterite/landing test:visual

# ============================================
# Local validator
# ============================================

# Start Surfpool with the programs installed; mode is fork (mainnet datasource) or offline
_start-surfpool mode="fork":
    #!/usr/bin/env bash
    set -euo pipefail
    program_id=$(just program-id)
    offline=""
    if [[ "{{mode}}" == "offline" ]]; then offline="--offline"; fi
    mkdir -p .surfpool
    nohup surfpool start --ci --no-tui --block-production-mode transaction $offline \
        --runbook surfnet-setup --port 8899 > .surfpool/surfpool.log 2>&1 &
    echo $! > .surfpool/pid.txt
    for _ in {1..30}; do
        if curl -sf http://127.0.0.1:8899 -H 'Content-Type: application/json' \
            -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$program_id\",{\"encoding\":\"base64\"}]}" \
            | grep -q '"executable":true'; then
            echo "✓ Surfpool ({{mode}}) ready"
            exit 0
        fi
        sleep 2
    done
    cat .surfpool/surfpool.log
    just kill-validator
    exit 1

# Start Surfpool unless one is already answering on port 8899
ensure-surfpool mode="fork": build-program
    #!/usr/bin/env bash
    set -euo pipefail
    if curl -sf http://127.0.0.1:8899 -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' >/dev/null; then
        echo "✓ Surfpool already running"
    else
        just _start-surfpool {{mode}}
    fi

# Stop the local Surfpool
kill-validator:
    #!/usr/bin/env bash
    surfpool stop --port 8899 >/dev/null 2>&1 || true
    if [[ -f .surfpool/pid.txt ]]; then kill "$(cat .surfpool/pid.txt)" 2>/dev/null || true; fi
    rm -f .surfpool/pid.txt
    echo "✓ Surfpool stopped"

# Run the mainnet-fork suite (needs network and a datasource RPC; not part of `just test`)
test-fork: build-program
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'just kill-validator' EXIT
    just kill-validator
    just _start-surfpool fork
    pnpm --filter @laterite/fork-tests test
# ============================================
# Format and lint
# ============================================

# Check formatting without writing
fmt-check:
    @cargo fmt --all --check
    @pnpm run format:check

# Format everything
fmt:
    @cargo fmt --all
    @pnpm run format

# Lint without fixing (the test target embeds the program binary, so build first)
lint-check: build-program
    @cargo clippy --workspace --all-targets --no-deps -- -D warnings
    @pnpm -r run lint

# Lint and apply safe fixes
lint: build-program
    @cargo clippy --workspace --all-targets --no-deps --fix --allow-dirty -- -D warnings
    @pnpm -r run lint --fix

# Format and lint checks
check: fmt-check lint-check

# ============================================
# Clean
# ============================================

# Remove build output and installed dependencies
clean:
    cargo clean
    rm -rf node_modules apps/*/node_modules apps/*/.next
    @echo "✓ Clean"
