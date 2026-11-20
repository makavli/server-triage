# Changelog

## 1.0.0 (2026-11-20)

- First release. The sheet has 12 sections: the triage loop, the first minute on a host, an error decoder, services and logs, resources, DNS and the network path, TLS, HTTP and proxies, containers and Kubernetes, PostgreSQL, MySQL and Redis.
- The app is one page built from `CHEATSHEET.md`. It has search (every word must match), click or Enter to copy, and a request path that links each hop to its section. It follows the light and dark system theme.
- It installs as an app from Edge or Chrome and works offline. `index.html` also opens from disk with no server. It makes no requests beyond its own files.
