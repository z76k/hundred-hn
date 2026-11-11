# The Hundred

A fast, read-only Hacker News reader. It shows stories with 100+ comments (except Jobs) and adds search, saved stories, read tracking, new-comment badges, For You, followed topics, reader view, side by side, and light/dark themes.

No server and no build step: it's plain HTML, CSS and JavaScript. Your saved stories, read marks and settings stay in the browser you use. They don't sync between devices.

## Publish it on GitHub Pages (about 10 minutes, all on github.com)

1. **Create a GitHub account** at [github.com](https://github.com) if you don't have one.
2. **Create a repository.** Click **+** (top right) → **New repository**.
   - Name it, for example, `hundred`.
   - Choose **Public**. Free GitHub Pages needs a public repository.
   - Leave everything else as it is and click **Create repository**.
3. **Upload the files.** On the new repository's page, click **uploading an existing file**.
   - Open the `hundred_hn` folder on your Mac, select **everything inside it** (not the folder itself), and drag it onto the page.
   - Check that `index.html`, `sw.js`, `manifest.webmanifest`, `icon.svg`, `styles.css` and all the `.js` files are in the list.
   - Click **Commit changes**.
4. **Turn on Pages.** Go to **Settings** (top of the repository) → **Pages** (left sidebar).
   - Under **Build and deployment**, set **Source** to **Deploy from a branch**.
   - Set **Branch** to **main** and the folder to **/ (root)**, then click **Save**.
5. **Wait 1–2 minutes**, then refresh the Pages settings page. It shows your address, like
   `https://YOUR-USERNAME.github.io/hundred/`. Open it.

## Put it on your phone or Dock

- **iPhone (Safari):** open your address → Share button → **Add to Home Screen**.
- **Android (Chrome):** open your address → ⋮ menu → **Install app** (or **Add to Home screen**).
- **Mac (Chrome or Dia):** open your address → address-bar install icon, or the menu → **Install The Hundred…**.
- **Mac (Safari):** **File → Add to Dock**.

## Updating it later

Upload the changed files to the same repository the same way (**Add file → Upload files**, replace the old ones, **Commit changes**). Within a minute or two GitHub publishes them. The next time you open the app it notices the new version and shows **"A new version is ready · Reload"**.

## Good to know

- **Offline:** after the first visit, the app itself opens instantly and works without a connection. Stories and threads you've already loaded are still there; new ones need a connection.
- **It also still works from the folder:** double-clicking `index.html` works as before (offline caching and installing only work on the hosted version).
- **Separate data:** the hosted version and the local-file version each keep their own saved stories and settings.
- **Reader view** fetches a text version of articles through r.jina.ai, which sees the article's address.
- **If something freezes:** Settings → **Debug log** → On. If it happens again, open Settings, click **Copy log**, and send it along.
