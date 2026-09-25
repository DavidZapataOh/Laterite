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
# The devnet CPMM's account keeps the zero padding of its first, larger build, so it is pinned by executable hash
cpmm_executable_hash := "dfe2e72d378f811835f379d5b4bb74dc7c7c713c55fbcb38cf373fbf1cb60269"

# Refresh the committed program fixtures (Subscriptions, mainnet and devnet Pyth Pro) and check our devnet CPMM against its fixture; fails when one no longer matches its pin
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
        "{{pyth_pro_devnet_sha256}} pyth_pro_devnet.so" "{{pyth_storage_devnet_sha256}} pyth_storage_devnet.bin"; do
        set -- $pin
        if ! echo "$1  $dir/$2" | shasum -a 256 -c --status; then
            echo "Error: $2 no longer matches its pinned hash."
            echo "Review the upstream change, then update its pin and run this again."
            exit 1
        fi
    done
    # The CPMM fixture is its local verifiable build, which the cluster must run
    for cpmm in "devnet $dir/cpmm.so" "fixture {{program_dir}}/tests/fixtures/cpmm.so"; do
        set -- $cpmm
        if [[ "$(solana-verify get-executable-hash "$2")" != "{{cpmm_executable_hash}}" ]]; then
            echo "Error: the $1 CPMM does not match its pinned executable hash."
            echo "Run 'just deploy-cpmm devnet' and 'just build-cpmm', or review the change and update the pin."
            exit 1
        fi
    done
    rm "$dir/cpmm.so"
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
test: unit-test client-test devnet-unit-test deployment-unit-test ui-test

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

# Type-check the deployment package and run its tests against the built program
deployment-unit-test: build-program
    pnpm --filter @laterite/deployment typecheck
    pnpm --filter @laterite/deployment test:unit

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

# Port of the relay between Surfpool and its mainnet datasource
relay_port := "8897"

# Start Surfpool with the programs installed; mode is fork (mainnet datasource, through the relay) or offline
_start-surfpool mode="fork":
    #!/usr/bin/env bash
    set -euo pipefail
    program_id=$(just program-id)
    mkdir -p .surfpool
    datasource=(--offline)
    if [[ "{{mode}}" == "fork" ]]; then
        nohup pnpm --silent --filter @laterite/fork-tests relay {{relay_port}} > .surfpool/relay.log 2>&1 &
        echo $! > .surfpool/relay.pid
        for _ in {1..50}; do curl -s -o /dev/null http://127.0.0.1:{{relay_port}} && break || sleep 0.2; done
        datasource=(--rpc-url http://127.0.0.1:{{relay_port}})
    fi
    # The relay reads the datasource's URL, so Surfpool never sees it
    nohup env -u SURFPOOL_DATASOURCE_RPC_URL surfpool start --ci --no-tui "${datasource[@]}" \
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
    for pid in .surfpool/pid.txt .surfpool/relay.pid; do
        if [[ -f "$pid" ]]; then kill "$(cat "$pid")" 2>/dev/null || true; fi
        rm -f "$pid"
    done
    echo "✓ Surfpool stopped"

# Run the mainnet-fork suite (needs network and PYTH_PRO_ACCESS_TOKEN; not part of `just test`)
test-fork: build-program
    #!/usr/bin/env bash
    set -euo pipefail
    pnpm --filter @laterite/fork-tests typecheck
    trap 'just kill-validator' EXIT
    just kill-validator
    just _start-surfpool fork
    pnpm --filter @laterite/fork-tests test

# Sample how far tier-sized Jupiter quotes fall below the program's price bound, for the given minutes (needs PYTH_PRO_ACCESS_TOKEN)
measure-slippage minutes="30":
    pnpm --silent --filter @laterite/fork-tests slippage {{minutes}}

# ============================================
# Devnet assets
# ============================================

# Generate any missing devnet keypair in keys/ and print every public key
devnet-keys:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p keys
    for name in issuer faucet treasury cpmm usdc usdt spyx qqqx authority attestor sponsor crank; do
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
        devnet) rpc="${DEVNET_RPC_URL:-https://api.devnet.solana.com}"; echo "$rpc ${rpc/#https:/wss:}" ;;
        *) echo "Error: unknown cluster {{cluster}} (local or devnet)" >&2; exit 1 ;;
    esac

# The devnet programs a deployment runs besides the CPMM: SPL Token, Token-2022, Address Lookup Table, Subscriptions, Pyth Pro, Program Metadata and the verifier
devnet_programs := "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb AddressLookupTab1e1111111111111111111111111 De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44 pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC"
# Associated Token (a loader v2 program) and Pyth Pro's storage and treasury
devnet_accounts := "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL 3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL opsLibxVY7Vz5eYMmSfX8cLFCFVYTtH6fr6MiifMpA7"

# Start a local devnet on port 18899, a new chain on Agave's test validator with devnet's features and a copy of every devnet program and account the deployment uses, and fund the issuer and the program's upgrade authority; `deployed` also copies Laterite's devnet deployment (program, accounts and record), to rehearse an upgrade
devnet-local state="fresh": devnet-keys
    #!/usr/bin/env bash
    set -euo pipefail
    health='{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
    if curl -sf http://127.0.0.1:18899 -H 'Content-Type: application/json' -d "$health" >/dev/null; then
        echo "✓ Local devnet already running"
        exit 0
    fi
    mkdir -p test-ledger
    record=$(just _devnet-deployment-file local)
    rm -f "$record"
    deployment=()
    case "{{state}}" in
        fresh) ;;
        deployed)
            # The copied lookup table was extended at a devnet slot, so the chain starts past it, at the first slot of
            # devnet's current epoch: the validator dates slots from the epoch's start, which keeps its clock on time
            epoch=$(solana epoch-info -u devnet --output json)
            warp=$(node -p "const e = $epoch; e.absoluteSlot - e.slotIndex")
            deployment=(--clone-upgradeable-program "$(just program-id)"
                --clone $(pnpm --silent --filter @laterite/deployment accounts) --warp-slot "$warp")
            cp "$(just _devnet-deployment-file devnet)" "$record" ;;
        *) echo "Error: unknown state {{state}} (fresh or deployed)" >&2; exit 1 ;;
    esac
    cpmm=$(node -p "require('./packages/devnet/addresses.json').cpmm.program")
    nohup solana-test-validator --reset --quiet --ledger test-ledger/devnet --rpc-port 18899 \
        --url devnet --clone-feature-set --clone-upgradeable-program "$cpmm" {{devnet_programs}} \
        --clone {{devnet_accounts}} $(pnpm --silent --filter @laterite/devnet accounts) "${deployment[@]}" \
        > test-ledger/devnet.log 2>&1 &
    echo $! > test-ledger/devnet.pid
    for _ in {1..60}; do
        if curl -sf http://127.0.0.1:18899 -H 'Content-Type: application/json' -d "$health" >/dev/null; then
            for key in issuer authority; do
                solana airdrop 100 "$(solana-keygen pubkey "keys/devnet-$key.json")" -u http://127.0.0.1:18899 >/dev/null
            done
            echo "✓ Local devnet ready"
            exit 0
        fi
        sleep 2
    done
    cat test-ledger/devnet.log
    just devnet-local-stop
    exit 1

# Stop the local devnet
devnet-local-stop:
    #!/usr/bin/env bash
    if [[ -f test-ledger/devnet.pid ]]; then kill "$(cat test-ledger/devnet.pid)" 2>/dev/null || true; fi
    rm -f test-ledger/devnet.pid
    echo "✓ Local devnet stopped"

# Build Raydium CPMM from its pinned source with our devnet ids in the verifiable-build image of the Solana version it pins, then regenerate its IDL and client
build-cpmm: devnet-keys
    #!/usr/bin/env bash
    set -euo pipefail
    src="{{cpmm_src}}"
    [[ -d "$src/.git" ]] || git clone --quiet https://github.com/raydium-io/raydium-cp-swap "$src"
    git -C "$src" fetch --quiet origin {{cpmm_commit}}
    git -C "$src" checkout --quiet --force {{cpmm_commit}}
    eval "$(pnpm --silent --filter @laterite/devnet cpmm-constants)"
    anchor=$(sed -n 's/^anchor_version = "\(.*\)"/\1/p' Anchor.toml)
    solana=$(sed -n 's/^solana_version = "\(.*\)"/\1/p' Anchor.toml)
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
        # The program builds in the verifiable-build image of the Solana version the source pins, which solana-verify
        # reads from the workspace; the IDL builds on the host with our toolchain, so Anchor never switches the host's CLI
        printf '\n[workspace.metadata.cli]\nsolana = "%s"\n' "$(sed -n 's/^solana_version = "\(.*\)"/\1/p' Anchor.toml)" >> Cargo.toml
        sed -i.orig -e "s/^anchor_version = .*/anchor_version = \"$anchor\"/" -e "s/^solana_version = .*/solana_version = \"$solana\"/" Anchor.toml
        rm Anchor.toml.orig
        solana-verify build --library-name raydium_cp_swap -- --features devnet
        mkdir -p target/idl
        anchor idl build -p raydium_cp_swap -o target/idl/raydium_cp_swap.json -- --features devnet >/dev/null
    )
    mkdir -p packages/devnet/idl
    cp "$src/target/idl/raydium_cp_swap.json" packages/devnet/idl/
    pnpm --filter @laterite/devnet generate-client
    pnpm exec prettier --write packages/devnet/idl packages/devnet/src/generated >/dev/null
    echo "✓ CPMM built: $(shasum -a 256 "$src/target/deploy/raydium_cp_swap.so" | cut -d' ' -f1)"

# Deploy or upgrade the CPMM to the build unless the cluster already runs the same executable
deploy-cpmm cluster="local": build-cpmm
    just _deploy-verified {{cluster}} {{cpmm_src}}/target/deploy/raydium_cp_swap.so keys/devnet-cpmm.json keys/devnet-issuer.json keys/devnet-cpmm-buffer.json

# Create or verify every devnet asset and write addresses.json (idempotent)
devnet-assets cluster="local": (deploy-cpmm cluster)
    #!/usr/bin/env bash
    set -euo pipefail
    read -r rpc ws < <(just _devnet-urls {{cluster}})
    DEVNET_RPC_URL=$rpc DEVNET_WS_URL=$ws pnpm --filter @laterite/devnet create-assets
    pnpm exec prettier --write packages/devnet/addresses.json >/dev/null

# ============================================
# Devnet deployment
# ============================================

priority_fee := "100000"

# Write a program's build into a buffer and deploy or upgrade from it as the upgrade authority, unless the cluster already runs the same executable. The buffer's keypair is kept, so a rerun resumes an interrupted upload; an upgrade to another executable asks for the program's address first and extends the program's data when the build outgrows it
_deploy-verified cluster binary program_key authority buffer_key:
    #!/usr/bin/env bash
    set -euo pipefail
    read -r url _ < <(just _devnet-urls {{cluster}})
    id=$(solana-keygen pubkey {{program_key}})
    build=$(solana-verify get-executable-hash {{binary}})
    # The executable hash ignores the zero padding a program account keeps after an upgrade to a smaller binary
    running=""
    if solana account -u "$url" "$id" >/dev/null 2>&1; then running=$(solana-verify get-program-hash -u "$url" "$id" | tail -n1); fi
    if [[ "$running" == "$build" ]]; then
        echo "✓ $id already runs $build on {{cluster}}"
        exit 0
    fi
    if [[ -n "$running" ]]; then
        echo "$id runs $running on {{cluster}}; the build is $build."
        read -r -p "Type $id to upgrade it: " answer
        if [[ "$answer" != "$id" ]]; then
            echo "Not upgraded"
            exit 1
        fi
    fi
    # solana-verify reads finalized state, which trails what the CLI confirms by about 32 slots
    finalized() {
        local confirmed
        confirmed=$(solana slot -u "$url" --commitment confirmed)
        until (( $(solana slot -u "$url" --commitment finalized) >= confirmed )); do sleep 1; done
    }
    signer=(-u "$url" --keypair {{authority}})
    options=("${signer[@]}" --with-compute-unit-price {{priority_fee}} --max-sign-attempts 50)
    [[ -f {{buffer_key}} ]] || solana-keygen new --no-bip39-passphrase --silent --outfile {{buffer_key}}
    buffer=$(solana-keygen pubkey {{buffer_key}})
    # write-buffer writes only the chunks a buffer does not hold yet, so running it again resumes an upload
    solana program write-buffer {{binary}} --buffer {{buffer_key}} "${options[@]}" >/dev/null
    finalized
    # solana-verify prints a missing CLI config's warning before the hash
    if [[ "$(solana-verify get-buffer-hash -u "$url" "$buffer" | tail -n1)" != "$build" ]]; then
        echo "Error: buffer $buffer does not hold the build"
        exit 1
    fi
    if [[ -n "$running" ]]; then
        # An upgrade needs program data at least as large as the build, and the loader never grows it on its own
        size=$(wc -c < {{binary}})
        capacity=$(solana program show "$id" "${signer[@]}" --output json | node -p "JSON.parse(require('fs').readFileSync(0)).dataLen")
        if (( size > capacity )); then
            solana program extend "$id" $(( size - capacity )) "${signer[@]}"
            finalized
        fi
        solana program upgrade "$buffer" "$id" --upgrade-authority {{authority}} "${signer[@]}"
    else
        solana program deploy --buffer "$buffer" --program-id {{program_key}} --upgrade-authority {{authority}} "${options[@]}"
    fi
    finalized
    echo "✓ $id runs $(solana-verify get-program-hash -u "$url" "$id" | tail -n1) on {{cluster}}"

# Deploy or upgrade the program to its verifiable build unless the cluster already runs the same executable
deploy-program cluster="local": build-program
    just _deploy-verified {{cluster}} target/deploy/laterite.so keys/laterite-program.json keys/devnet-authority.json keys/devnet-laterite-buffer.json

# Print where a devnet target's deployment is recorded: committed for devnet, beside the local devnet's ledger for local
_devnet-deployment-file cluster:
    #!/usr/bin/env bash
    case "{{cluster}}" in
        local) echo "$PWD/test-ledger/devnet-deployment.json" ;;
        devnet) echo "$PWD/packages/devnet/deployment.json" ;;
        *) echo "Error: unknown cluster {{cluster}} (local or devnet)" >&2; exit 1 ;;
    esac

# On devnet, refuse to run unless every devnet key exists and the deployment's keys are the recorded ones: devnet never generates a key
_require-deployment-keys cluster:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ "{{cluster}}" != devnet ]]; then exit 0; fi
    for name in laterite-program devnet-issuer devnet-faucet devnet-treasury devnet-cpmm devnet-usdc devnet-usdt \
        devnet-spyx devnet-qqqx devnet-authority devnet-attestor devnet-sponsor; do
        if [[ ! -f "keys/$name.json" ]]; then
            echo "Error: keys/$name.json is missing; devnet runs only with the keys the local rehearsal used"
            exit 1
        fi
    done
    if [[ "$(solana-keygen pubkey keys/laterite-program.json)" != "$(just program-id)" ]]; then
        echo "Error: keys/laterite-program.json is not the key of $(just program-id)"
        exit 1
    fi
    record=$(just _devnet-deployment-file devnet)
    if [[ -f "$record" ]]; then
        for pair in "upgradeAuthority devnet-authority" "attestor devnet-attestor" "sponsor devnet-sponsor"; do
            set -- $pair
            recorded=$(node -p "require('$record').$1")
            if [[ "$(solana-keygen pubkey "keys/$2.json")" != "$recorded" ]]; then
                echo "Error: keys/$2.json is not the recorded $1 $recorded"
                exit 1
            fi
        done
    fi

# Check, read-only, what a devnet target needs before a deployment or an upgrade: the SOL the authority and the issuer must hold at the cluster's rent, SIMD-0500 inactive, no stray buffers
devnet-preflight cluster="local": (_require-deployment-keys cluster) build-program build-cpmm
    #!/usr/bin/env bash
    set -euo pipefail
    read -r rpc ws < <(just _devnet-urls {{cluster}})
    key() { if [[ -f "keys/$1.json" ]]; then solana-keygen pubkey "keys/$1.json"; fi; }
    DEVNET_RPC_URL=$rpc DEVNET_WS_URL=$ws DEVNET_DEPLOYMENT_FILE=$(just _devnet-deployment-file {{cluster}}) \
        DEVNET_AUTHORITY=$(key devnet-authority) DEVNET_ISSUER=$(key devnet-issuer) DEVNET_SPONSOR=$(key devnet-sponsor) \
        DEVNET_LATERITE_BUFFER=$(key devnet-laterite-buffer) DEVNET_CPMM_BUFFER=$(key devnet-cpmm-buffer) \
        pnpm --silent --filter @laterite/deployment preflight

# Deploy Laterite to a devnet target after its assets, then bring its config, plans, swap-authority accounts, market calendar and onboarding lookup table to the committed configuration (idempotent)
devnet-deploy cluster="local": (_require-deployment-keys cluster) (devnet-assets cluster) (deploy-program cluster)
    #!/usr/bin/env bash
    set -euo pipefail
    read -r rpc ws < <(just _devnet-urls {{cluster}})
    record=$(just _devnet-deployment-file {{cluster}})
    # The attestor's and sponsor's public keys come from the record; only the first run takes them from keys/
    if [[ ! -f "$record" ]]; then
        export DEVNET_ATTESTOR=$(solana-keygen pubkey keys/devnet-attestor.json)
        export DEVNET_SPONSOR=$(solana-keygen pubkey keys/devnet-sponsor.json)
    fi
    DEVNET_RPC_URL=$rpc DEVNET_WS_URL=$ws DEVNET_DEPLOYMENT_FILE=$record pnpm --silent --filter @laterite/deployment configure
    pnpm exec prettier --write "$record" >/dev/null

# Rotate the attestor or the sponsor: a new key set with update_config and recorded, the retired key kept in keys/retired/ (a retired sponsor still signs the Restore of subscriptions it paid for)
rotate-key cluster role: (_require-deployment-keys cluster)
    #!/usr/bin/env bash
    set -euo pipefail
    read -r rpc ws < <(just _devnet-urls {{cluster}})
    record=$(just _devnet-deployment-file {{cluster}})
    current="keys/devnet-{{role}}.json"
    next="keys/devnet-{{role}}.next.json"
    # A rerun after a failed update keeps the key it generated
    [[ -f "$next" ]] || solana-keygen new --no-bip39-passphrase --silent --outfile "$next"
    DEVNET_RPC_URL=$rpc DEVNET_WS_URL=$ws DEVNET_DEPLOYMENT_FILE=$record \
        pnpm --silent --filter @laterite/deployment rotate-key {{role}} "$(solana-keygen pubkey "$next")"
    pnpm exec prettier --write "$record" >/dev/null
    mkdir -p keys/retired
    mv "$current" "keys/retired/devnet-{{role}}-$(solana-keygen pubkey "$current").json"
    mv "$next" "$current"
    echo "✓ $current is the new {{role}}: move it to the secret store of the service that signs with it"

# Verify that a devnet target runs the program of a pushed commit: rebuild it from the public repository in the verifiable-build image, compare the hashes and record the verification on-chain as the upgrade authority
verify-program cluster="devnet" ref="origin/main":
    #!/usr/bin/env bash
    set -euo pipefail
    read -r url _ < <(just _devnet-urls {{cluster}})
    repository=$(sed -n 's/^repository = "\(.*\)"/\1/p' Cargo.toml)
    # solana-verify reads a Solana CLI config even when every option is given
    config=$(mktemp)
    trap 'rm -f "$config"' EXIT
    solana config set -C "$config" --url "$url" --keypair keys/devnet-authority.json >/dev/null
    verify=(solana-verify -c "$config" verify-from-repo "$repository" --program-id "$(just program-id)"
        --commit-hash "$(git rev-parse {{ref}})" --library-name laterite --arch v3
        -u "$url" -k "$PWD/keys/devnet-authority.json")
    "${verify[@]}" -y

# Propose a new admin, such as a Squads vault, which takes over when it signs accept_admin (a vault proposal); the default key cancels a pending proposal
propose-admin cluster new_admin:
    #!/usr/bin/env bash
    set -euo pipefail
    read -r rpc ws < <(just _devnet-urls {{cluster}})
    DEVNET_RPC_URL=$rpc DEVNET_WS_URL=$ws pnpm --silent --filter @laterite/deployment propose-admin {{new_admin}}

program_metadata_version := "0.10.0"

# Publish the IDL with the Program Metadata program, unless the cluster already holds this one, so explorers decode the program's instructions
deploy-idl cluster="local":
    #!/usr/bin/env bash
    set -euo pipefail
    read -r url ws < <(just _devnet-urls {{cluster}})
    id=$(just program-id)
    # The Program Metadata CLI takes its WebSocket URL only from the Solana CLI config in the home directory
    home=$(mktemp -d)
    trap 'rm -rf "$home"' EXIT
    solana config set -C "$home/.config/solana/cli/config.yml" --url "$url" --ws "$ws" \
        --keypair "$PWD/keys/devnet-authority.json" >/dev/null
    pm() { HOME="$home" npm_config_cache="$(npm config get cache)" npx -y @solana-program/program-metadata@{{program_metadata_version}} "$@"; }
    if pm fetch idl "$id" 2>/dev/null | node -e "
        const onChain = JSON.parse(require('fs').readFileSync(0, 'utf8'));
        const local = require('./idl/laterite.json');
        process.exit(JSON.stringify(onChain) === JSON.stringify(local) ? 0 : 1);"; then
        echo "✓ {{cluster}} already holds this IDL for $id"
        exit 0
    fi
    pm write idl "$id" idl/laterite.json --priority-fees {{priority_fee}}

# Check a devnet target's deployment against the built program and the committed configuration, and Pyth Pro there (read-only)
test-deployment cluster="local": build-program
    #!/usr/bin/env bash
    set -euo pipefail
    read -r rpc ws < <(just _devnet-urls {{cluster}})
    DEVNET_RPC_URL=$rpc DEVNET_WS_URL=$ws DEVNET_DEPLOYMENT_FILE=$(just _devnet-deployment-file {{cluster}}) \
        pnpm --filter @laterite/deployment test:deployment

# Re-peg the pools, then enroll a fresh faucet-funded wallet per payment token and sweep it through the CPMM with live Pyth Pro updates (needs PYTH_PRO_ACCESS_TOKEN)
devnet-smoke cluster="local": (devnet-repeg cluster)
    #!/usr/bin/env bash
    set -euo pipefail
    read -r rpc ws < <(just _devnet-urls {{cluster}})
    DEVNET_RPC_URL=$rpc DEVNET_WS_URL=$ws DEVNET_DEPLOYMENT_FILE=$(just _devnet-deployment-file {{cluster}}) \
        pnpm --filter @laterite/deployment test:smoke

# Reload the market calendar from programs/laterite/data/nyse-calendar.json unless the config holds it (after a new NYSE year or closure)
market-calendar cluster="local":
    #!/usr/bin/env bash
    set -euo pipefail
    read -r rpc ws < <(just _devnet-urls {{cluster}})
    record=$(just _devnet-deployment-file {{cluster}})
    DEVNET_RPC_URL=$rpc DEVNET_WS_URL=$ws DEVNET_DEPLOYMENT_FILE=$record pnpm --silent --filter @laterite/deployment market-calendar
    pnpm exec prettier --write "$record" >/dev/null

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
# Services
# ============================================

# The Postgres Railway runs (major version 18), pinned by digest
postgres_image := "postgres:18.6-alpine3.24@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873"

# Start a disposable Postgres on 127.0.0.1:<port> and print the DATABASE_URL to export for the services' recipes and tests
db-up name="laterite-postgres" port="54320":
    #!/usr/bin/env bash
    set -euo pipefail
    docker run -d --rm --name {{name}} -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:{{port}}:5432 {{postgres_image}} >/dev/null
    until docker exec {{name}} pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; do sleep 0.5; done
    echo "export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:{{port}}/postgres"

# Stop a Postgres started by db-up, which removes it
db-down name="laterite-postgres":
    @docker stop {{name}} >/dev/null && echo "✓ {{name}} removed"

# Apply the committed migrations to DATABASE_URL
db-migrate:
    pnpm --filter @laterite/db migrate

# Fail when the committed migrations differ from packages/db/src/schema.ts
db-check:
    #!/usr/bin/env bash
    set -euo pipefail
    pnpm --silent --filter @laterite/db exec drizzle-kit generate >/dev/null
    if ! git diff --quiet -- packages/db/migrations || [[ -n "$(git ls-files --others --exclude-standard -- packages/db/migrations)" ]]; then
        git status --short -- packages/db/migrations
        echo "Error: the migrations are out of date. Run 'pnpm --filter @laterite/db generate' and commit the result."
        exit 1
    fi
    echo "✓ Migrations match the schema"

# Type-check the services and run their tests against DATABASE_URL and a local validator on port 28899
services-test: build-program
    pnpm --filter @laterite/db typecheck
    pnpm --filter @laterite/operator typecheck
    pnpm exec tsc -p .railway
    pnpm --filter @laterite/db test
    pnpm --filter @laterite/operator test

# Build the operator's container image from the repository root, as Railway builds it
operator-image tag="laterite-operator":
    docker build -f services/operator/Dockerfile -t {{tag}} .

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
