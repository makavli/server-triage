# Changelog

## 1.1.0 (2026-11-20)

- The sheet grows from 12 sections to 20, 1329 entries in all. New: storage and filesystems, AWS, Google Cloud and Azure, the JVM, Node.js, Python and Go runtimes, Kafka and RabbitMQ, SQL Server, SQLite, MongoDB, and Elasticsearch and OpenSearch. PostgreSQL, MySQL and MariaDB, and Redis go much deeper (replication, locks, vacuum, memory, slow queries), and so do the host, network and Kubernetes sections. The commands and error texts were run in containers on the versions the sheet's intro names; the cloud CLIs were checked for syntax only, and the few errors that could not be triggered come from each project's own docs or source.
- Tags: a command that changes state says **Changes state**, one that can lose data says **Can lose data**, and a command for one distribution or from one version on says so (Debian and Ubuntu, RHEL family, PostgreSQL 16+).
- Setup: type your values once (host, pod, database...) and every command shows and copies them. Filters hide what changes state, keep one distribution, or hide what needs a newer version than yours.
- Pins and notes on any entry, gathered at the top; your own entries, searchable with the rest. They stay in this browser's local database, and Export and Import move them between devices as a JSON file.
- Search knows synonyms (`oom` finds "out of memory"), highlights the matches, and the arrow keys or `j` and `k` walk the results.
- Every entry has its own link, which opens the sheet on it; an old link to an entry that changed falls back to its section.

## 1.0.0 (2026-11-20)

- First release. The sheet has 12 sections: the triage loop, the first minute on a host, an error decoder, services and logs, resources, DNS and the network path, TLS, HTTP and proxies, containers and Kubernetes, PostgreSQL, MySQL and Redis.
- The app is one page built from `CHEATSHEET.md`. It has search (every word must match), click or Enter to copy, and a request path that links each hop to its section. It follows the light and dark system theme.
- It installs as an app from Edge or Chrome and works offline. `index.html` also opens from disk with no server. It makes no requests beyond its own files.
