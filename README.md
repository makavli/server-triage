# Server Triage Sheet

Commands and error meanings for debugging a broken Linux host, service or database. Its 12 sections run from a triage loop and the first minute on a host, through the network path, TLS, proxies and containers, to PostgreSQL, MySQL and Redis. Each entry is one command or one error message, followed by what it tells you and where to look next.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.png">
  <img alt="The sheet in a browser. A request path runs from Client to Database, above a search box and the first sections of commands." src="docs/screenshot-light.png">
</picture>

## Open it

- **In a browser:** [makavli.github.io/server-triage](https://makavli.github.io/server-triage/). After the first visit it works offline.
- **As a Windows app:** open that page in Edge or Chrome and choose **Install app** (the button in the page or the icon in the address bar). The app gets its own window and a Start menu entry, and opens with no network.
- **From disk:** download `index.html` from the [latest release](https://github.com/makavli/server-triage/releases/latest) and open it in any browser. It is one self-contained file: search and copy work, but opened from disk it has no icon, no Install button and no offline worker (browsers allow those only over https).
- **In a terminal:** [CHEATSHEET.md](CHEATSHEET.md) is the same content in plain Markdown, for `less` or `grep`.

## Use it

- **Copy a command:** click it, or focus it and press Enter. Placeholders in capitals (HOST, PID, POD, SVC, APP) are yours to fill.
- **Search:** press `/` and type. Every word must match, in any order, so `postgresql lock` finds the lock entries of the PostgreSQL section. Esc clears the search.
- **Find where it breaks:** the request path at the top is the order to debug in, from DNS to the database. Each hop links to its section. Test the hops from left to right and dig where the first one fails.

The commands target Linux with systemd, OpenSSL 1.1.1 or later, PostgreSQL 13+, MySQL 8.0 and Redis 6+. The commands for reading a system are safe to run on a live host. The ones that change state say so: restart, kill, flush, terminate.

## Privacy

The page makes no network requests beyond its own files. It sends no analytics and no fonts, and it does not keep your searches. The only thing it stores is its offline copy in the browser's cache. You can see this in its [Content-Security-Policy](tools/build.mjs): `default-src 'none'`.

## Contribute

All the content is in `CHEATSHEET.md`. The page is built from it, so a fix to the sheet is a fix to the app.

1. Edit `CHEATSHEET.md`. An entry is a ` ```sh `, ` ```sql ` or ` ```text ` block (text is for an error message or a state, not a command), followed by one paragraph. Run each new command on a real host first, and make the paragraph say what its output means.
2. Run `npm run bump <version>` and write the `CHANGELOG.md` entry. Every merge into main is a release.
3. Run `npm run build`, then `npm run check`. The check needs Node 22 or later, and it runs a headless Chrome or Edge test when one of them is installed.
4. Open a pull request. The checks run on Linux and Windows. While they are red, an issue tracks them; it closes when they turn green.

`npm run icons` redraws the icons. `npm run shots` retakes the screenshots above (headless: no window opens).

## Licence

[MIT](LICENSE). Report a security problem privately: see [SECURITY.md](SECURITY.md).
