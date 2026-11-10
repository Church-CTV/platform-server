function createExperimentalBillingGuard(environment = process.env) {
    return (_request, response, next) => {
        if (environment.NODE_ENV !== 'test' || environment.ENABLE_EXPERIMENTAL_BILLING !== 'true') {
            return response.status(503).json({ error: 'experimental_billing_disabled' });
        }
        return next();
    };
}

module.exports = { createExperimentalBillingGuard };
