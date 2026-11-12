# Release status

**PUBLIC SOURCE — first public revision 2026-11-12.** The Church CTV Community
Source License version 1.0 in `LICENSE` is operative from this revision; see
`LICENSING-STATUS.md` for what it grants and what it does not claim.

Public source is not a supported release. It is not a device certification, a
store approval, a signing identity, a hosted service or a production migration.
Unrun checks stay named as unrun: hardware playback and focus behavior, release
signing, store submission and review, and any cross-platform acceptance matrix
that has not been executed inside the last month are NOT RUN, and no passing
test here is evidence that they passed.

Fresh history. This repository's history starts from the selected current tree;
it does not carry the private lineage's commits, issues, pull requests, Actions
logs, artifacts, environments or secrets. Publication is a copy-out, not a move:
production services, DNS, store listings, signing credentials and the private
coordination repositories are unchanged by publication, and nothing here
authorizes touching them. Comments in the code cite internal verification
records by name ("the private record …", "the private plan of record"); those
records live in a private coordination repository, so they are citations for
traceability, not links into this tree.

Secrets and security posture. The selected tree, every revision in this short
history, every object reachable in that history, and the hosted CI logs that
become public with the repository were scanned with pinned Gitleaks (redacted
output, inline suppressions disabled, no `.gitleaks.toml` and no
`.gitleaksignore`), with a supplemental hygiene audit, with an independent
pattern/entropy scanner that shares no suppression list with the others, and by
hand; none of them reported a credential. Gitleaks skips binary content, so the
database sidecars that exist only in this history were cleared separately by
reading their bytes (`test-device-*`, `rate-test-*`; no address, URL, email or
token shape), and the sidecar bytes were read by hand. The layers are complementary, and the limits are measured rather than
assumed: a planted random-shape `ghp_…` token fires on every layer, a planted
degenerate `ghp_…` body (an alphabet run, as some test fixtures use) fires on the
prefix and entropy layers but not on Gitleaks, whose GitHub rule is entropy-gated,
and a planted 17-character human passphrase fires on none of the automated
layers - only on the hand pass. So the claim is 'no credential found by four
automated layers and one manual pass over a defined history', not 'no credential
is possible'. That is a measured result about this history, not a security
certification. Secret scanning, push protection and
private vulnerability reporting are measured after the visibility change, not
assumed. Any credential found in a private ancestor is rotated at its issuer,
because deleting a file is not rotation.

Dependency and notice posture: dependency alerts are enabled and were clear of
open high/critical advisories at publication; collected third-party license texts
are in `THIRD-PARTY-LICENSES.json` with declared metadata in
`DEPENDENCY-LICENSE-INVENTORY.json`. Both are inventories, not legal clearance.
Anyone redistributing compiled builds owns the binary-distribution notices,
source-offer duties and vendor SDK terms for their own release.

On the Free GitHub plan, private branch protection cannot be enforced on a
private repository and private vulnerability reporting was not available while
these repositories were private; both are re-checked as public, and none of that
is represented as a merged-code guarantee.
