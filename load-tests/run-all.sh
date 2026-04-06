#!/usr/bin/env bash
#
# Castle Companion Load Test Runner
# Runs all load tests in sequence against the Mock Disney API + Castle Backend
#
# Prerequisites:
#   1. Install k6: brew install k6
#   2. Start Mock Disney API: cd mock-disney-api && npm run dev
#   3. Start Castle Backend: npm run dev
#
# Usage:
#   ./load-tests/run-all.sh                    # Run all tests
#   ./load-tests/run-all.sh --test 03          # Run only test 03
#   ./load-tests/run-all.sh --quick            # Run quick versions (reduced VUs)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="${SCRIPT_DIR}/results"
mkdir -p "${RESULTS_DIR}"

CASTLE_URL="${CASTLE_URL:-http://localhost:3000}"
MOCK_DISNEY_URL="${MOCK_DISNEY_URL:-http://localhost:3099}"

# Parse args
SINGLE_TEST=""
QUICK_MODE=false
for arg in "$@"; do
    case $arg in
        --test) SINGLE_TEST="$2"; shift 2 ;;
        --quick) QUICK_MODE=true; shift ;;
    esac
done

echo "🏰 Castle Companion Load Test Suite"
echo "   Castle Backend: ${CASTLE_URL}"
echo "   Mock Disney API: ${MOCK_DISNEY_URL}"
echo "   Results: ${RESULTS_DIR}"
echo ""

# Check prerequisites
command -v k6 >/dev/null 2>&1 || { echo "❌ k6 not installed. Run: brew install k6"; exit 1; }

# Verify services are running
if ! curl -sf "${CASTLE_URL}/api/telemetry" > /dev/null 2>&1; then
    echo "⚠️  Castle Backend not reachable at ${CASTLE_URL}"
    echo "   Start it: cd castle-backend && npm run dev"
    exit 1
fi

run_test() {
    local test_file="$1"
    local test_name=$(basename "$test_file" .js)
    local extra_args="${2:-}"

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🏃 Running: ${test_name}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    k6 run \
        -e BASE_URL="${CASTLE_URL}" \
        -e CASTLE_URL="${CASTLE_URL}" \
        -e MOCK_DISNEY_URL="${MOCK_DISNEY_URL}" \
        ${extra_args} \
        "${test_file}" 2>&1 | tee "${RESULTS_DIR}/${test_name}.log"

    echo ""
}

# Run tests
if [[ -n "${SINGLE_TEST}" ]]; then
    run_test "${SCRIPT_DIR}/${SINGLE_TEST}*.js"
else
    echo "📋 Test 1/5: Baseline Health"
    if $QUICK_MODE; then
        run_test "${SCRIPT_DIR}/01_baseline_health.js" "--vus 50 --duration 30s"
    else
        run_test "${SCRIPT_DIR}/01_baseline_health.js"
    fi

    echo "📋 Test 2/5: Auth + DB Read"
    if $QUICK_MODE; then
        run_test "${SCRIPT_DIR}/02_auth_db_read.js" "--vus 25 --duration 30s"
    else
        run_test "${SCRIPT_DIR}/02_auth_db_read.js"
    fi

    # Check if Mock Disney API is running for tests 3-5
    if curl -sf "${MOCK_DISNEY_URL}/health" > /dev/null 2>&1; then
        echo "📋 Test 3/5: 7AM LL Rush"
        run_test "${SCRIPT_DIR}/03_ll_rush.js"

        echo "📋 Test 4/5: Soak Test (SKIPPED in quick mode)"
        if ! $QUICK_MODE; then
            echo "⚠️  Soak test runs for 8 hours. Run manually:"
            echo "   k6 run load-tests/04_soak_test.js"
        fi

        echo "📋 Test 5/5: Failure & Recovery"
        run_test "${SCRIPT_DIR}/05_failure_recovery.js"
    else
        echo "⚠️  Mock Disney API not running — skipping tests 3-5"
        echo "   Start it: cd mock-disney-api && npm run dev"
    fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Load test suite complete"
echo "   Results saved to: ${RESULTS_DIR}/"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
