# Contributing

Contributions are welcome. A pull request here is a code contribution under the
Church CTV Community Source License (source-available, not open source), so two
things are required and neither is a formality.

**1. Accept the Contributor Agreement.** Put this line in the pull-request
description, exactly:

    I agree to the Church CTV Contributor Agreement v1.0 and certify the
    representations in section 4.

`CONTRIBUTOR-AGREEMENT.md` explains what that grants: you keep your copyright,
and the owner may ship your change under this license, a later version of it, or
a commercial release. A pull request without that line is reviewed but not
merged. You may open issues, fork and experiment without it.

**2. Say what is yours.** Do not submit code, artwork, fonts, feeds or data you
cannot license here. If something is AI-assisted, say so and say what it was
derived from. If you add a dependency, name it and its license in the pull
request; the license inventory and notice files are part of this repository and
a new runtime dependency changes them.

## Before you write code

Open an issue first for anything that is not a typo: a screen layout, a config
key, a feed field, a schema change, a cache behavior, a client contract. These
four repositories share versioned contracts, so a change that looks local often
crosses a platform boundary, and an issue is where that gets caught before you
spend an evening. Keep fixture data synthetic and services local or mocked.

## How a change lands here

A runtime change needs a failing regression test first, then the fix, then the
same test passing; include the actual commands and output, before and after, in
the pull request. Include dependency changes and any limitation you could not
test. A contribution never authorizes deployment to a production channel, a
device, or a store: those are separate, authorized operations, and device or
store verification is often NOT RUN even for merged code.

Hosted CI for a pull request from a fork is read-only: it has a read-only
`contents` token, no secrets, no deployment, no self-hosted runner and no access
to any production endpoint. It cannot approve or publish anything.

Read `SECURITY.md` before reporting a vulnerability, and `SUPPORT.md` for what
belongs in an issue versus email.
