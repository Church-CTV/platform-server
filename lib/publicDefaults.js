function telemetryEndpoint(env) {
    if (env.CTV_TELEMETRY_ENABLED !== 'true' || !env.OTEL_EXPORTER_OTLP_ENDPOINT) return null;
    return env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, '');
}
function corsOrigins(env) {
    return env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean) : ['http://localhost:3000', 'http://127.0.0.1:3000'];
}
module.exports = { telemetryEndpoint, corsOrigins };
