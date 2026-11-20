# Security

## What is in scope

The Server Triage Sheet is one static page built from `CHEATSHEET.md`, a service worker that keeps an offline copy, and the Node scripts that build and test them. The page loads nothing from elsewhere and sends nothing anywhere. A policy (`default-src 'none'`, hashed inline code, Trusted Types) enforces this.

A security problem is anything that could make the page do more than that:
- run code it was not built with, for example through Markdown in the sheet that escapes into the page;
- reach another origin;
- store or send what a user types;
- make the offline copy serve something other than the published files.

Two limits are known and accepted:
- Another site can show the page in a frame. A policy set in a `<meta>` tag cannot forbid framing (`frame-ancestors`), and GitHub Pages sends no `X-Frame-Options` header. The page has no action that changes anything, and a framing site cannot change the text a click copies.
- Every project site of one GitHub account shares one origin, so another site there could delete or rewrite the offline copy. The worker reads only its own cache, deletes only caches named `triage-*`, and fetches again a file its cache lost.

A command in the sheet that does harm when it is run as written also counts: one that changes state while the sheet presents it as read-only, or one that leaks a secret into a log or into shell history.

## Supported versions

The latest release is supported. It is always the tip of `main`: a fix is released when it is merged.

## Reporting a problem

Please do not open a public issue. Report the problem privately through GitHub's [private vulnerability reporting](https://github.com/makavli/server-triage/security/advisories/new). Say what you found, how to reproduce it and what it could let someone do.
