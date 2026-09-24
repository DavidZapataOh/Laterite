# Laterite build automation
# https://github.com/casey/just

set shell := ["bash", "-uc"]
set dotenv-load

# The verifiable-build image is amd64 only; Apple Silicon runs it under Rosetta
export DOCKER_DEFAULT_PLATFORM := "linux/amd64"

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
    for cmd in pnpm cargo solana anchor surfpool docker solana-verify; do
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

# Build the program, then the router its tests route through, in the pinned verifiable-build image: every machine builds the bytes a deployment verifies
build-program:
    #!/usr/bin/env bash
    set -euo pipefail
    # The container builds as root; creating target/ first keeps it writable for the host's own builds
    mkdir -p target
    # One library per build: a workspace build unifies the router's dependency features into the program's
    solana-verify build --library-name laterite --arch v3
    solana-verify build --library-name test_router --arch v3
    echo "✓ Program built: $(shasum -a 256 target/deploy/laterite.so | cut -d' ' -f1)"

# Build the landing page
build-landing:
    pnpm --filter @laterite/landing build
    @echo "✓ Landing built"

# ============================================
# Test
# ============================================

subscriptions_sha256 := "af3cefa5947173e03298361b3f461e2a314382a7206c084f77ad9a40c8b18d3a"
pyth_pro_mainnet_sha256 := "3cfe21cea519b47f63196fc29f05822ec74a0ca563dfba0d51d0516eb50ce023"
pyth_storage_mainnet_sha256 := "9317148d8a36da529f5eec39d325cd6ae2c15eb2c3e00f5d020dcf41e8544d21"
pyth_pro_devnet_sha256 := "a23441843d485a8bbae0f0b2e561e3453691c2843b506b63f02adc1bca6fb6bb"
pyth_storage_devnet_sha256 := "bc95799804292206529561227b9c376c6de09fd3f9d463aed94c275f30b36cbe"
cpmm_sha256 := "6c6d893d4f43f6d747f18b2130482a7259d1ad27cc98cee36dd2451cdec00dc3"

# Refresh the committed program fixtures (mainnet and devnet Pyth Pro, our devnet CPMM); fails when one no longer matches its pin
dump-programs:
    #!/usr/bin/env bash
    set -euo pipefail
    dir=$(mktemp -d)
    trap 'rm -rf "$dir"' EXIT
    solana program dump -u mainnet-beta De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44 "$dir/subscriptions.so" >/dev/null
    for cluster in mainnet devnet; do
        url=$([[ "$cluster" == mainnet ]] && echo mainnet-beta || echo devnet)
        solana program dump -u "$url" pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt "$dir/pyth_pro_$cluster.so" >/dev/null
        solana account -u "$url" 3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL --output-file "$dir/pyth_storage_$cluster.bin" >/dev/null
    done
    solana program dump -u devnet "$(node -p "require('./packages/devnet/addresses.json').cpmm.program")" "$dir/cpmm.so" >/dev/null
    for pin in "{{subscriptions_sha256}} subscriptions.so" \
        "{{pyth_pro_mainnet_sha256}} pyth_pro_mainnet.so" "{{pyth_storage_mainnet_sha256}} pyth_storage_mainnet.bin" \
        "{{pyth_pro_devnet_sha256}} pyth_pro_devnet.so" "{{pyth_storage_devnet_sha256}} pyth_storage_devnet.bin" \
        "{{cpmm_sha256}} cpmm.so"; do
        set -- $pin
        if ! echo "$1  $dir/$2" | shasum -a 256 -c --status; then
            echo "Error: $2 no longer matches its pinned hash."
            echo "Review the upstream change, then update its pin and run this again."
            exit 1
        fi
    done
    mkdir -p "{{program_dir}}/tests/fixtures"
    cp "$dir"/* "{{program_dir}}/tests/fixtures/"
    echo "✓ Program fixtures match their pins"

# Snapshot the devnet mints, CPMM config and pools the sweep tests copy; review the diff before committing
dump-devnet-accounts:
    #!/usr/bin/env bash
    set -euo pipefail
    dir="{{program_dir}}/tests/fixtures/devnet"
    mkdir -p "$dir"
    accounts=$(node -p "const a = require('./packages/devnet/addresses.json');
        [a.cpmm.ammConfig, ...Object.values(a.tokens).map((t) => t.mint),
         ...['SPYx-USDC', 'SPYx-USDT', 'QQQx-USDC'].flatMap((p) => ['address', 'observation', 'token0Vault', 'token1Vault'].map((k) => a.pools[p][k]))].join(' ')")
    for account in $accounts; do
        solana account -u devnet "$account" --output-file "$dir/$account.bin" >/dev/null
    done
    echo "✓ Devnet accounts written to $dir"

# Write cu_report.md with every instruction's and transaction's compute units, as the CU Benchmark workflow reads it
test-and-benchmark: build-program
    CU_REPORT=1 cargo test -p laterite --test test_sweep cu_report

# Run every suite CI runs
test: unit-test client-test devnet-unit-test ui-test

# Type-check the TypeScript client and run its tests against the built program
client-test: build-program
    pnpm --filter @laterite/client typecheck
    pnpm --filter @laterite/client test

# Rewrite the conformance vectors the TypeScript client is tested against; review their diff like code
vectors: build-program
    UPDATE_VECTORS=1 cargo test -p laterite --test test_vectors

# Type-check the shared UI package and run its tests
ui-test:
    pnpm --filter @laterite/ui typecheck
    pnpm --filter @laterite/ui test

# Type-check the devnet package and run its offline tests
devnet-unit-test:
    pnpm --filter @laterite/devnet typecheck
    pnpm --filter @laterite/devnet test:unit

# Run the program tests against the built binary
unit-test: build-program
    cargo test -p laterite

# Compare the landing with its screenshot baseline (macOS baselines, local only)
test-visual: build-landing
    pnpm --filter @laterite/landing test:visual

# ============================================
# IDL and clients
# ============================================

generated_paths := "idl clients/typescript/src/generated"

# Generate the IDL into idl/ (its build compiles the tests, which embed the program binary)
generate-idl: build-program
    @anchor idl build -p laterite -o idl/laterite.json >/dev/null
    @pnpm exec prettier --write idl/laterite.json >/dev/null
    @echo "✓ IDL generated"

# Generate the TypeScript client from the IDL
generate-clients: generate-idl
    @pnpm run generate-clients
    @pnpm exec prettier --write clients/typescript/src/generated >/dev/null
    @echo "✓ Clients generated"

# Fail when the committed IDL or client differs from the program
check-generated: generate-clients
    #!/usr/bin/env bash
    set -euo pipefail
    if ! git diff --quiet -- {{generated_paths}} || [[ -n "$(git ls-files --others --exclude-standard -- {{generated_paths}})" ]]; then
        git status --short -- {{generated_paths}}
        echo "Error: generated files are out of date. Run 'just generate-clients' and commit the result."
        exit 1
    fi
    pnpm --filter @laterite/client typecheck
    echo "✓ Generated files are up to date"

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
# Devnet assets
# ============================================

# Generate any missing devnet keypair in keys/ and print every public key
devnet-keys:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p keys
    for name in issuer faucet treasury cpmm usdc usdt spyx qqqx; do
        file="keys/devnet-$name.json"
        [[ -f "$file" ]] || solana-keygen new --no-bip39-passphrase --silent --outfile "$file"
        echo "$name $(solana-keygen pubkey "$file")"
    done

cpmm_commit := "59fb845a9e5bb569c8b2f3415f13b0c0ebcc6b92"
cpmm_src := "target/cp-swap"

# Print the RPC and WebSocket URLs of a devnet target (local or devnet)
_devnet-urls cluster:
    #!/usr/bin/env bash
    case "{{cluster}}" in
        local) echo "http://127.0.0.1:18899 ws://127.0.0.1:18900" ;;
        devnet) echo "https://api.devnet.solana.com wss://api.devnet.solana.com" ;;
        *) echo "Error: unknown cluster {{cluster}} (local or devnet)" >&2; exit 1 ;;
    esac

# Start a local Surfpool that forks devnet on port 18899 and fund the issuer
devnet-local: devnet-keys
    #!/usr/bin/env bash
    set -euo pipefail
    health='{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
    if curl -sf http://127.0.0.1:18899 -H 'Content-Type: application/json' -d "$health" >/dev/null; then
        echo "✓ Local devnet already running"
        exit 0
    fi
    mkdir -p .surfpool
    nohup surfpool start --ci --no-tui --no-deploy --block-production-mode transaction \
        --rpc-url https://api.devnet.solana.com --port 18899 --ws-port 18900 \
        > .surfpool/devnet.log 2>&1 &
    echo $! > .surfpool/devnet-pid.txt
    for _ in {1..30}; do
        if curl -sf http://127.0.0.1:18899 -H 'Content-Type: application/json' -d "$health" >/dev/null; then
            solana airdrop 100 "$(solana-keygen pubkey keys/devnet-issuer.json)" -u http://127.0.0.1:18899 >/dev/null
            echo "✓ Local devnet ready"
            exit 0
        fi
        sleep 2
    done
    cat .surfpool/devnet.log
    just devnet-local-stop
    exit 1

# Stop the local devnet
devnet-local-stop:
    #!/usr/bin/env bash
    surfpool stop --port 18899 >/dev/null 2>&1 || true
    if [[ -f .surfpool/devnet-pid.txt ]]; then kill "$(cat .surfpool/devnet-pid.txt)" 2>/dev/null || true; fi
    rm -f .surfpool/devnet-pid.txt
    echo "✓ Local devnet stopped"

# Build Raydium CPMM from its pinned source with our devnet ids, then regenerate its client
build-cpmm: devnet-keys
    #!/usr/bin/env bash
    set -euo pipefail
    src="{{cpmm_src}}"
    [[ -d "$src/.git" ]] || git clone --quiet https://github.com/raydium-io/raydium-cp-swap "$src"
    git -C "$src" fetch --quiet origin {{cpmm_commit}}
    git -C "$src" checkout --quiet --force {{cpmm_commit}}
    eval "$(pnpm --silent --filter @laterite/devnet cpmm-constants)"
    files=(programs/cp-swap/src/lib.rs
        programs/cp-swap/src/instructions/admin/create_support_mint_associated.rs
        programs/cp-swap/src/instructions/admin/create_permission_pda.rs)
    (
        cd "$src"
        sed -i.orig \
            -e "s/DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb/$PROGRAM_ID/" \
            -e "s/DRayqG9RXYi8WHgWEmRQGrUWRWbhjYWYkCRJDd6JBBak/$ADMIN/" \
            -e "s/3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy/$POOL_FEE_RECEIVER/" \
            -e "s/DRaydJNq54dSDHUqYCE3G8YySgaXfZucbh7dTXw9fBMs/$ADMIN/" \
            -e "s/DRay33UmULQCeawH3dVpJfN3uqLj6Qtq4ymSRx2pAgGK/$ADMIN/" \
            -e "s/DRaypyeDL6y1dUusMgwyeDM5JebjhsSi8aRXobKQ9DcQ/$ADMIN/" \
            -e "s/DRayJkSKsijbcEqdooK4uUGcT6gjbEuwUh7V6Nmqct7M/$ADMIN/" \
            "${files[@]}"
        for f in "${files[@]}"; do rm "$f.orig"; done
        if grep -rqE 'DRay|3oE58BKV' programs/cp-swap/src; then
            echo "Error: an upstream devnet key survived the patch"
            exit 1
        fi
        anchor build --ignore-keys -- --features devnet
    )
    # The pinned source's Anchor.toml switches the active Solana CLI; switch back to ours
    agave-install init "$(sed -n 's/^solana_version = "\(.*\)"/\1/p' Anchor.toml)" >/dev/null
    mkdir -p packages/devnet/idl
    cp "$src/target/idl/raydium_cp_swap.json" packages/devnet/idl/
    pnpm --filter @laterite/devnet generate-client
    pnpm exec prettier --write packages/devnet/idl packages/devnet/src/generated >/dev/null
    echo "✓ CPMM built: $(shasum -a 256 "$src/target/deploy/raydium_cp_swap.so" | cut -d' ' -f1)"

# Deploy the CPMM build unless the cluster already runs the same binary
deploy-cpmm cluster="local": build-cpmm
    #!/usr/bin/env bash
    set -euo pipefail
    read -r url _ < <(just _devnet-urls {{cluster}})
    so="{{cpmm_src}}/target/deploy/raydium_cp_swap.so"
    id=$(solana-keygen pubkey keys/devnet-cpmm.json)
    transport=()
    if [[ "{{cluster}}" == local ]]; then
        # Surfpool exposes no TPU, so program writes go through RPC
        transport=(--use-rpc)
        # An idle Surfpool 1.6 fork stalls the first transaction that fetches a remote account if a read fetched one before it
        fresh=$(solana-keygen new --no-outfile --no-bip39-passphrase | sed -n 's/^pubkey: //p')
        solana transfer "$fresh" 0.001 --allow-unfunded-recipient -u "$url" --keypair keys/devnet-issuer.json >/dev/null
    fi
    if solana program dump -u "$url" "$id" "{{cpmm_src}}/onchain.so" >/dev/null 2>&1 \
        && cmp -s "$so" "{{cpmm_src}}/onchain.so"; then
        echo "✓ CPMM $id already deployed on {{cluster}}"
        exit 0
    fi
    solana program deploy "$so" -u "$url" --program-id keys/devnet-cpmm.json \
        --upgrade-authority keys/devnet-issuer.json --keypair keys/devnet-issuer.json ${transport[@]+"${transport[@]}"}
    echo "✓ CPMM $id deployed on {{cluster}}"

# Create or verify every devnet asset and write addresses.json (idempotent)
devnet-assets cluster="local": (deploy-cpmm cluster)
    #!/usr/bin/env bash
    set -euo pipefail
    read -r rpc ws < <(just _devnet-urls {{cluster}})
    DEVNET_RPC_URL=$rpc DEVNET_WS_URL=$ws pnpm --filter @laterite/devnet create-assets
    pnpm exec prettier --write packages/devnet/addresses.json >/dev/null

# Run the devnet asset suite (needs keys/ and network; not part of `just test`)
test-devnet cluster="local":
    #!/usr/bin/env bash
    set -euo pipefail
    read -r rpc ws < <(just _devnet-urls {{cluster}})
    DEVNET_RPC_URL=$rpc DEVNET_WS_URL=$ws pnpm --filter @laterite/devnet test:devnet

# Swap every pool back to the live mainnet price
devnet-repeg cluster="local":
    #!/usr/bin/env bash
    set -euo pipefail
    read -r rpc ws < <(just _devnet-urls {{cluster}})
    DEVNET_RPC_URL=$rpc DEVNET_WS_URL=$ws pnpm --filter @laterite/devnet repeg

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
# Fuzz
# ============================================

fuzz_targets := "invariant_sweep invariant_attest invariant_controls invariant_admin"

# Build one fuzz target's harness in release, as `anchor fuzz run` does; the first build compiles Crucible, LibAFL and LiteSVM
fuzz-build target="invariant_sweep":
    cd fuzz/laterite && RUSTUP_TOOLCHAIN=stable cargo build --release --features {{target}}

# Fuzz one invariant target of fuzz/laterite (release build); extra args pass through to `anchor fuzz run`
fuzz target="invariant_sweep" seconds="60" *args: build-program (fuzz-build target)
    anchor fuzz run laterite {{target}} --release --timeout {{seconds}} {{args}}

# Fail when a fuzz target left crashes; the fuzzer itself exits 0 on them
fuzz-check target:
    #!/usr/bin/env bash
    set -euo pipefail
    crashes="fuzz/laterite/crashes/{{target}}"
    # The fuzzer also keeps an empty .crash_corpus directory there, so look for crash files only
    if [[ -d "$crashes" && -n "$(find "$crashes" -maxdepth 1 -type f -name 'crash_*')" ]]; then
        ls -la "$crashes"
        echo "Error: {{target}} found crashes. List them with 'anchor fuzz show laterite'."
        exit 1
    fi
    echo "✓ No crashes in {{target}}"

# Run every fuzz target for a minute, as CI does on each change
fuzz-smoke: build-program
    #!/usr/bin/env bash
    set -euo pipefail
    for target in {{fuzz_targets}}; do
        rm -rf "fuzz/laterite/crashes/$target"
        just fuzz-build "$target"
        anchor fuzz run laterite "$target" --release --timeout 60
        just fuzz-check "$target"
    done

# ============================================
# Security
# ============================================

# Check the Rust and JavaScript dependencies against their advisory databases (reviewed ignores: .cargo/audit.toml, pnpm-workspace.yaml)
audit:
    cargo audit
    pnpm audit

sss_version := "1.12.1"

# Scan the program against the Solana Security Standard, as the Security workflow does; fails on findings not in the baseline
scan:
    npx -y @jelleo/solana-security-standard@{{sss_version}} scan --no-color --root . --baseline .sss-baseline.json -- {{program_dir}}/src

# Rewrite the scan baseline after reviewing every finding; review its diff like code
scan-baseline:
    npx -y @jelleo/solana-security-standard@{{sss_version}} scan --no-color --no-fail --root . --write-baseline .sss-baseline.json -- {{program_dir}}/src >/dev/null
    @pnpm exec prettier --write .sss-baseline.json >/dev/null

# ============================================
# Clean
# ============================================

# Remove build output and installed dependencies
clean:
    cargo clean
    rm -rf node_modules apps/*/node_modules apps/*/.next
    @echo "✓ Clean"
