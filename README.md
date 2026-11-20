# Server Triage Sheet

A one-page sheet for debugging a broken Linux host, service or database. Each entry is one command or one error message, then what it tells you and where to look next. It works offline and installs as an app.

<img alt="Typing &quot;postgresql lock&quot; in the search box narrows the sheet to the PostgreSQL lock entries; clicking the first command copies it and shows &quot;Copied&quot;." src="docs/demo.png" width="720">

**[Open the sheet](https://makavli.github.io/server-triage/)** · [Download it](https://github.com/makavli/server-triage/releases/latest) · [Read it as Markdown](CHEATSHEET.md)

## What's in it

Twelve sections, in the order you debug:

- **Where to start:** the triage loop, the first minute on a host, and an error decoder.
- **The host:** services and logs; CPU, memory, disk and files.
- **The way in:** DNS, ports and packets; TLS and certificates; HTTP, proxies and load balancers; containers and Kubernetes.
- **The data:** PostgreSQL, MySQL and MariaDB, and Redis.

The commands target Linux with systemd, OpenSSL 1.1.1+, PostgreSQL 13+, MySQL 8.0 and Redis 6+. Commands that read are safe on a live host. Commands that change state (restart, kill, flush, terminate) say so.

## Use it

- **Copy:** click a command, or focus it and press Enter. Words in capitals (HOST, PID, POD, SVC, APP) are placeholders to fill in.
- **Search:** press `/` and type. Every word must match, in any order. Esc clears.
- **Follow the path:** the hops at the top (Client, DNS, Network, TLS and on to Database) are the order to test in. Each one links to its section. Dig where the first one fails.

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.png">
    <img alt="The sheet on a desktop: the request path from Client to Database above the search box and the first section." src="docs/screenshot-light.png" width="600">
  </picture>
  <img alt="The same sheet on a phone, in the dark theme." src="docs/screenshot-phone.png" width="180">
</p>

## Get it

- **Browser:** open [makavli.github.io/server-triage](https://makavli.github.io/server-triage/). After the first visit it works offline.
- **Windows app:** open that page in Edge or Chrome and choose **Install app**. It gets its own window and a Start menu entry, and it works without a network.
- **One file:** download `index.html` from the [latest release](https://github.com/makavli/server-triage/releases/latest) and open it in any browser. Search and copy work. Install and offline need https, so they don't work from disk.
- **Terminal:** [CHEATSHEET.md](CHEATSHEET.md) is the same content as plain Markdown, for `less` or `grep`.

**Privacy:** the page loads only its own files. It has no analytics or web fonts, and it doesn't store your searches. Its [Content-Security-Policy](tools/build.mjs) starts with `default-src 'none'`.

## Contribute

The page is built from `CHEATSHEET.md`, so a fix to the sheet is a fix to the app.

1. Edit `CHEATSHEET.md`. An entry is a ` ```sh `, ` ```sql ` or ` ```text ` block, followed by one paragraph. Use `text` for an error message or a state. Run each new command on a real host first.
2. Run `npm run bump <version>` and write the `CHANGELOG.md` entry. Every merge into main is a release.
3. Run `npm run build`, then `npm run check`. The check needs Node 22+, and it also runs a headless Chrome or Edge test when one is installed.
4. Open a pull request. The checks run on Linux and Windows. While they are red, an issue tracks them.

`npm run icons` redraws the icons. `npm run shots` retakes these pictures headless; the animation also needs ffmpeg.

## Licence

[MIT](LICENSE). To report a security problem privately, see [SECURITY.md](SECURITY.md).
