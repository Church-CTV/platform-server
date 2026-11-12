# Security policy

## How to report

Use this repository's **Report a vulnerability** form (the Security tab). It
reaches the maintainers privately and is not public. If that form is not
available to you, email `dominick253@gmail.com` with the subject line
`Church CTV security report — private`, and ask for a private channel before
sending details. Do not open a public issue for an unpatched problem, and do not
attach secrets or credentials to an issue or a public gist.

## What to include

The repository and version or commit, the platform and version, a minimal
synthetic reproduction (a fake feed or config, not a customer's), the impact and
what an attacker would need to be able to do. Never test a report against a
production channel, origin or store listing without explicit authorization.

## What to expect

Reports are read by the project owner or a maintainer. There is no published
response-time or fix-time SLA, no security-embargo promise, no bug-bounty and no
security certification. Scanner passes (including the pinned Gitleaks run in
this repository's CI) are hygiene, not a guarantee that no credential or defect
exists. A fix, when one is made, is published in the repository and the release
notes; coordinated disclosure is agreed with the reporter where possible.

## Ground rules learned the hard way

Removing a file is not revocation: a credential that appeared in any past
revision or CI log must be rotated at its issuer, and rotation on a live system
is a separate authorized change. Configuration and secret placement rules are in
`RUNTIME-CONFIGURATION.md`. Never commit a production value to "make CI green";
an unset credential must make the build produce a debug/unsigned artifact or
fail with a reason. Client applications must never carry server credentials,
because a packaged TV application reveals its own configuration.
