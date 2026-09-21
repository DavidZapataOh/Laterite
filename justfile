# Laterite build automation
# https://github.com/casey/just

set shell := ["bash", "-uc"]

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
    for cmd in pnpm cargo solana anchor; do
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
