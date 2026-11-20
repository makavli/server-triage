# Changelog

## 1.1.1 (2026-11-20)

- Delete my data, and deleting one of your entries, now need a real second click: a double-click, a quick second click or a held Enter no longer deletes.
- A value in Setup takes letters, digits and `. _ : / @ + = , % -` (a port or a process ID, digits only), and cannot start with `-`, so a command you copy never gets a quote, a `;`, a `$(...)` or an extra option from it. A value that does not fit is marked and the last good one holds; a file or a stored value that does not fit is dropped.
- An import asks one question that lists everything the file changes: the entries it adds or replaces, with their code, the notes, the pins, the values and the filters. A file with nothing new says so.
- A database that fails to load (or loads slowly) is no longer overwritten by the next change to your values or filters.
- The characters refused as hidden now include every unusual space (no-break and the like), soft hyphens, variation selectors and the other invisible ones. The build, the page and the repository checks share one list.
- A search no longer breaks on text holding a letter whose lower case is longer, such as the Turkish İ.
- The sheet: `sh.stopBalancer()` and `sh.startBalancer()`, `pg_wal_replay_pause()` and `pg_wal_replay_resume()`, and the two `REPLICAOF` commands each get their own entry, so one copy no longer undoes itself or hits two nodes, and the build now fails on such a pair. `CLIENT KILL id ID` fills only the id (the build checks for a keyword spelled like a blank). py-spy says that it pauses the process unless you add `--nonblocking`, `CONFIG GET tls-*` warns that key passphrases print in clear, and `stop-writes-on-bgsave-error no` is tagged as able to lose data. Links to the entries that were split now land on their section.

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
