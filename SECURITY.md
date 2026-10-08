# Security policy

## Supported versions

Security fixes are made for the latest release only. Please update to the newest
version before reporting.

| Version | Supported |
|---------|-----------|
| latest release (0.2.x) | yes |
| older releases | no |

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report them privately through GitHub's private vulnerability reporting: open the
**Security** tab of this repository and choose **Report a vulnerability**
(<https://github.com/MainMaxton/reolink-camera-audiohook/security/advisories/new>).

Please include:

- the version of the integration and of Home Assistant,
- what an attacker can do and the steps to reproduce,
- any proof of concept, with passwords, IP addresses, serial numbers and camera
  names removed.

You can expect an acknowledgement within 7 days. Fixes are released as soon as
practical, and the advisory is published once a fixed release is available.
Reporters are credited unless they prefer otherwise.

## Scope

In scope: the code in this repository, for example credential handling, the
Baichuan client, the actions and their input validation (such as the local file
path check of `play_file`), and diagnostics redaction.

Out of scope: vulnerabilities in Reolink firmware, Home Assistant itself, or
third-party services such as the edge-tts voice service. Please report those to
their vendors.
