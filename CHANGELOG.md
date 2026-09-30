# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 0.4.1 - 2026-09-30

### Fixed

- Encode non-Latin-1 route metadata before placing it in the `x-askr-head`
  response header, preventing HTTP 500 responses for Unicode titles and
  descriptions.
- Percent-encode Unicode redirect locations while preserving existing percent
  escapes, so internationalized paths produce valid `Location` headers.
