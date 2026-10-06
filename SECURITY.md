# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

1. Go to this repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the problem, how to reproduce it, and what it lets someone do.

Only the maintainer sees the report, and will reply there. Once a fix is
released, you'll be credited in the release notes if you'd like to be.

## What's in scope

- **The desktop app**: the Electron app on Windows, macOS and Linux, its
  installers, and anything that lets a page, file or other program run code
  in it or read data it shouldn't.
- **What leaves the computer**: anything that sends identifying details
  (computer name, user name, IP or MAC address, Wi-Fi name) somewhere the
  app says it doesn't. Shared reports and the data sent for **Explain my
  results** are both meant to be limited; see `app/INTEGRATION.md`.
- **The Explain service** (`server/report-mailer`, a Cloudflare Worker):
  anything that exposes its API key, gets around its rate limits or daily
  budget, or makes it do something other than explain a scan.

## Supported versions

Only the latest release gets security fixes. The installers aren't signed
yet, so download them only from this repository's **Releases** page.
