# The exported site

This is a static [Astro](https://astro.build) project: real source, not a pre-built
bundle. `npx astro build` writes `dist/`, and `dist/` is what a web server serves.

## Run it

    npm ci
    npm run build      # writes dist/
    npm run preview    # serves dist/ locally

`npm run dev` gives you the live editor with hot reload while you make changes.

## Edit it

- **A page's content** is `src/content/pages/<name>.html` — an HTML fragment, the same
  bytes the hosted editor stores. Edit it directly.
- **The shell** is `src/components/Shell.astro` — the `<head>`, the `<main>`, the
  `<style>` block. One edit applies to every page.
- **A page's URL, title and CSS** are in its `src/pages/<name>.astro` file, in the
  `<Shell … />` call.

Add a page by adding `src/pages/<name>.astro` and `src/content/pages/<name>.html`.

## Media

The images and files are under `public/media/`, at the paths the pages already
reference (`/media/<key>.<ext>`). Replacing a file with the same name replaces the
image everywhere; there is no build step for media.
