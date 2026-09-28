# Maintenance Policy

Skynet is maintained by a single maintainer,
[@gilad12-coder](https://github.com/gilad12-coder), who also runs the hosted
service at [skynetml.com](https://skynetml.com). This page says what support
you can expect and how quickly issues and pull requests get an answer. Read
it alongside [`CONTRIBUTING.md`](CONTRIBUTING.md) and
[`SECURITY.md`](SECURITY.md).

## What is maintained

- **`main` is the supported line.** Fixes land on `main` first and ship in the
  next tagged release. Older releases do not get backports; the fix is to
  upgrade.
- **Pre-1.0 versioning.** Until 1.0, a minor release (`0.x`) may include
  breaking changes. Each one is called out in the release notes with the
  steps to upgrade. Database migrations run automatically at boot, so
  upgrading a self-hosted deployment is normally just deploying the new
  version.
- **Dependencies.** Dependabot opens update PRs weekly for the backend,
  frontend, and GitHub Actions. They are merged once CI passes. Advisories
  that have no upstream fix are tracked in [`SECURITY.md`](SECURITY.md)
  rather than dismissed.

## Response times

These are targets for a **first response**, not for a fix. They are counted
in business days, and holidays and travel can stretch them.

| What you sent                                   | First response   |
| ----------------------------------------------- | ---------------- |
| Security vulnerability (privately, see below)   | 5 business days  |
| Bug that loses data or breaks a deployment      | 5 business days  |
| Other bug report                                | 10 business days |
| Pull request                                    | 10 business days |
| Feature request or question                     | Best effort      |

Fixes are worked in this order:

1. Security vulnerabilities
2. Data loss or corruption, and deployments that fail to start
3. Regressions from a recent release
4. Other bugs
5. Features and improvements

## Issues

- Search existing issues before opening a new one.
- For bugs, include the version or commit, how you run Skynet (hosted,
  Docker, or local), steps to reproduce, and relevant logs. **Remove API
  keys and other secrets from logs before you post them.**
- An issue waiting on information from the reporter is closed after 30 days
  without a reply. Reopen it any time you have the details.
- Never report a security issue in a public issue. Follow
  [`SECURITY.md`](SECURITY.md) instead.

## Pull requests

- For anything larger than a small fix, open an issue first so the approach
  can be agreed before you write the code.
- CI must pass, and the PR should follow [`CONTRIBUTING.md`](CONTRIBUTING.md).
- A PR that has waited 30 days for changes the review asked for may be
  closed. You are welcome to reopen it when you pick it back up.
- Not every PR can be accepted. When one is declined, the reason is given.

## The hosted service

GitHub issues are for the open-source code. For your skynetml.com account,
billing, credits, or refunds, email
[support@skynetml.com](mailto:support@skynetml.com). For privacy requests,
email [privacy@skynetml.com](mailto:privacy@skynetml.com). Please keep
account and payment details out of public issues.

## If this policy changes

If maintenance slows down, changes hands, or stops, this file and the README
will say so first. Skynet is licensed under [AGPL-3.0](LICENSE), so anyone can
fork it and carry it on.
