# Release status

**PRIVATE / NOT APPROVED FOR PUBLICATION**

Candidate-specific limits: Docker has not been built locally. Hosted Docker
verification applies to the previously pushed revision, not these local changes.
Billing is an experimental stub with known identity/privacy defects; its routes
are disabled by default and require both test mode and an explicit test flag.
It cannot be enabled by that flag in production mode. Local guard/HTTP and
isolated stub tests pass. npm audit reports zero findings including development
tools after moving to the patched ESLint 9 toolchain.

The source omits production operations, customer content and live configuration.
Full npm production dependency notice texts are collected; non-npm components,
ownership and legal authority remain subject to review. Local tests do not
certify a production deployment.

Six tracked SQLite test WAL/SHM files were removed from the current tree before
the continuation push. Their earlier private Git history was not rewritten;
secret-scanner results do not establish that historical database state is safe
to publish. Historical state review remains a publication gate.

Publication requires exact-tree security and manual privacy review, classified
historical findings, code/asset ownership, third-party notices, dependency
vulnerability triage and appropriate local tests/builds.

Qualified software-licensing counsel must finalize the licensor identity, church
eligibility, commercial restriction, share-back duties, contributor agreement and
service/support terms. Drafts grant no rights and are not described as airtight.

CI for untrusted contributions is read-only and cannot deploy. Supported GitHub
security protections and a private reporting channel must be checked. Do not copy
production credentials into GitHub variables. Preparing source does not authorize
production migration, signing, store submission or credential rotation. Unrun
device/store checks stay NOT RUN. Keep candidates private until gates pass.
