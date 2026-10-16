#!/usr/bin/env bash
# Run against the sandbox: SANDBOX=on npm start, then bash examples/curl.sh
set -euo pipefail
URL=${MOMO_URL:-http://localhost:8789}
AUTH=${MOMO_API_KEY:+-H "Authorization: Bearer $MOMO_API_KEY"}

echo "--- Collect GHS 25.00 from an MTN customer"
curl -s -X POST "$URL/v1/collections" $AUTH -H "content-type: application/json" -H "Idempotency-Key: example-order-1" \
  -d '{"amount":2500,"currency":"GHS","phone":"024 123 4567","network":"mtn","customer":{"email":"ama@example.com"},"description":"Order 1"}'
echo

echo "--- The same request again returns the same payment (no second charge)"
curl -s -i -X POST "$URL/v1/collections" $AUTH -H "content-type: application/json" -H "Idempotency-Key: example-order-1" \
  -d '{"amount":2500,"currency":"GHS","phone":"024 123 4567","network":"mtn","customer":{"email":"ama@example.com"},"description":"Order 1"}' | grep -i "idempotent-replayed"

echo "--- Pay GHS 100.00 out to a Telecel customer whose wallet is short (sandbox number ...0002)"
curl -s -X POST "$URL/v1/payouts" $AUTH -H "content-type: application/json" -H "Idempotency-Key: example-payout-1" \
  -d '{"amount":10000,"currency":"GHS","phone":"020 000 0002","network":"telecel","customer":{"name":"Kofi Boateng"}}'
echo

echo "--- Reconciliation report"
curl -s "$URL/v1/reconciliation" $AUTH | head -c 300
echo
