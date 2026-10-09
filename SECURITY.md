# Security Policy

Gritos is a serverless P2P chat that runs entirely in the browser: there is no server, no backend and no account database to compromise. Vulnerability reports are welcome and are handled privately — thank you for helping keep users safe.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

v1.x is the only supported line, and only the **latest release built from `main`** receives security fixes. There is no LTS or backport policy: if you run an older v1.x release, upgrade rather than patch.

## Reporting a Vulnerability

Use **GitHub's private vulnerability reporting** — open this repository's **Security** tab and click **"Report a vulnerability"**. This is the only supported disclosure channel.

- **Never open a public GitHub issue for a security report**, even for something that looks trivial.
- Please include:
  - the affected version (git tag or commit hash) and the browser(s) you tested;
  - a minimal reproduction — steps, crafted payloads, protocol envelopes or a patch;
  - your impact assessment, mapped against the scope below.

## Response Expectations

- You will get an **acknowledgement within 7 days** of filing.
- The reporter is kept informed through triage, fix and release.
- Credit in the fix's release notes unless you ask to remain anonymous.

## Scope

**In scope**

- **P2P protocol** — application `Envelope` handling in `src/lib/p2p/`: resistance to malformed, replayed or flooded messages from malicious peers.
- **Cryptography** — identity keys and the IndexedDB vault, E2EE direct messages (ECDH + HKDF + AES-256-GCM), room-key derivation (PBKDF2-SHA-256), `roomId` hashing, TOFU fingerprints.
- **CSP / XSS in the shipped bundle** — the strict CSP meta, the safe Markdown renderer, the frame-bust bootstrap script.
- **Dependency-level issues in the runtime bundle** — dependencies are exact-pinned and `npm audit --audit-level=high` gates CI; report anything that gate would miss.

**Out of scope — accepted limitations**

The following are documented trade-offs, not vulnerabilities (threat model: [docs/spec.md §9.5](docs/spec.md)). Reports arguing otherwise are still welcome, but may be closed as wontfix:

- Same-origin compromise (malicious extension with host permissions, malware on the device): a fully compromised origin can reach `localStorage` and IndexedDB and abuse the identity key despite the at-rest wrapping.
- WebRTC metadata exposure: connected peers and trackers see your IP address; discovery leaks join timing and opaque room ids.
- Weak room passwords: PBKDF2 raises the cost, but a trivial password remains brute-forceable offline by anyone who knows the room name.
- _Harvest now, decrypt later_ on DMs: static-static ECDH means a future compromise of one private key decrypts the whole recorded history; the fix is planned via the forward-secrecy roadmap (issue #25).
- Tracker availability or malice: trackers are third-party infrastructure and are documented as untrusted (see the ["Public trackers notice"](docs/security.md#public-trackers-notice)).
- Physical or device compromise where the app already documents the residual risk.

For the complete picture, read the threat model in [docs/spec.md §9.5](docs/spec.md) plus the [security model](docs/security.md) and the [limitations reference](docs/limitations.md).
