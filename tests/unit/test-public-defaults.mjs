import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
test("telemetry requires explicit opt-in and endpoint", () => {
    const { telemetryEndpoint } = require("../../lib/publicDefaults");
    assert.equal(telemetryEndpoint({}), null);
    assert.equal(telemetryEndpoint({ CTV_TELEMETRY_ENABLED: "true" }), null);
    assert.equal(telemetryEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.invalid" }), null);
    assert.equal(telemetryEndpoint({ CTV_TELEMETRY_ENABLED: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.invalid/" }), "https://collector.example.invalid");
});
test("CORS defaults to loopback and accepts explicit origins", () => {
    const { corsOrigins } = require("../../lib/publicDefaults");
    assert.deepEqual(corsOrigins({}), ["http://localhost:3000", "http://127.0.0.1:3000"]);
    assert.deepEqual(corsOrigins({ CORS_ORIGINS: "https://app.example.invalid" }), ["https://app.example.invalid"]);
});
test("example secrets are empty and telemetry disabled", () => {
    const example = readFileSync(".env.example", "utf8");
    assert.match(example, /^ADMIN_PASSWORD=$/m);
    assert.match(example, /^SESSION_SECRET=$/m);
    assert.match(example, /^ANALYTICS_API_KEY=$/m);
    assert.match(example, /^STRIPE_WEBHOOK_SECRET=$/m);
    assert.match(example, /^CTV_TELEMETRY_ENABLED=false$/m);
    assert.match(example, /^OTEL_EXPORTER_OTLP_ENDPOINT=$/m);
});
test("server applies the safety defaults to exporters and CORS", () => {
    const server = readFileSync('server.js', 'utf8');
    assert.match(server, /telemetryEndpoint\(process\.env\)/);
    assert.match(server, /if \(otlpEndpoint\)\s*\{\s*sdk = new NodeSDK/);
    assert.match(server, /resolveCorsOrigins\(process\.env\)/);
    assert.match(server, /sdk \? sdk\.shutdown\(\) : Promise\.resolve\(\)/);
});
