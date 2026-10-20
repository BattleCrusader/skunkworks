## Appendix A — the stored bytes, per component

`B1` is the row after the first save (insert from the palette); `B2` is the row after
reloading `?page=<id>` and saving again. Both are pasted from
`scratch/s4a/evidence.json`, which the driver wrote from `SELECT body_html`: where a block
says "B1 = B2" the two strings are equal and the sha256 of both is printed. The full 64-hex is
in that file.

**hero** — B1 = B2, 476 B, `sha256:f9a61b93…`
```html
<body>
  <section data-gjs-type="hero" class="hero" data-align="left">
    <div class="hero__inner">
      <h1 class="hero__title" data-prop="title">A headline that says what this is</h1>
      <p class="hero__subtitle" data-prop="subtitle">One sentence about who it is for.</p>
      <img class="hero__image" data-asset-key="banner/home" data-prop="image" alt />
      <a class="btn btn--primary" data-prop="cta" href="/contact">Talk to us</a>
    </div>
  </section>
</body>
```

**prose** — B1 = B2, 113 B, `sha256:3b451074…`
```html
<body>
  <div data-gjs-type="prose" class="prose"><p data-prop="body">Write the paragraph here.</p></div>
</body>
```

**figure** — B1 = B2, 210 B, `sha256:5aeda7b7…`
```html
<body>
  <figure data-gjs-type="figure" class="figure" data-ratio="4:3">
    <img data-asset-key="banner/home" data-prop="src" alt />
    <figcaption data-prop="caption">Caption</figcaption>
  </figure>
</body>
```

**gallery** — B1 = B2, 188 B, `sha256:1c4d9a41…`
```html
<body>
  <div data-gjs-type="gallery" class="gallery" data-columns="3">
    <figure class="gallery__item"><img data-asset-key="banner/home" data-prop="src" alt /></figure>
  </div>
</body>
```

**download-button** — B1 = B2, 205 B, `sha256:b6214134…`
```html
<body>
  <p data-gjs-type="download-button" class="download">
    <a class="btn" data-asset-key="vault/book" data-prop="href">
      <span data-prop="label">Download the book</span>
    </a>
  </p>
</body>
```

**cta** — B1 = B2, 206 B, `sha256:2c2dd66a…`
```html
<body>
  <aside data-gjs-type="cta" class="cta">
    <p class="cta__title" data-prop="title">Ready when you are.</p>
    <a class="btn" data-prop="target" href="/contact">Get in touch</a>
  </aside>
</body>
```

**form** — B1 = B2, 352 B, `sha256:9155b74e…`
```html
<body>
  <form data-gjs-type="form" class="form" data-form="contact">
    <label class="form__label">
      Email
      <input
        class="form__input"
        data-prop="email"
        name="email"
        placeholder="you@example.com"
        type="email"
      />
    </label>
    <button class="btn" type="submit">Send</button>
  </form>
</body>
```

**embed** — B1 = B2, 141 B, `sha256:0f3b0285…`
```html
<body>
  <div data-gjs-type="embed" class="embed">
    <p class="embed__label" data-prop="src">https://example.com/embed</p>
  </div>
</body>
```

**list** — B1 = B2, 385 B, `sha256:06dc03fa…`
```html
<body>
  <div data-gjs-type="list" class="list" data-limit="3" data-source="posts">
    <article class="card" data-item-position="0" data-repeat>
      <h3 class="card__title" data-bind-title="title">Post title</h3>
      <a class="card__link" data-bind-href-slug="slug" href="/blog/post">Read</a>
    </article>
    <p class="list__empty" data-empty>No posts yet.</p>
  </div>
</body>
```

**copy-email** — B1 = B2, 244 B, `sha256:f6f703b9…`
```html
<body>
  <button
    data-gjs-type="copy-email"
    class="island island--copy-email"
    data-island="copy-email"
    data-prop="address"
    data-props='{"address":"hello@example.com"}'
    type="button"
  >
    Copy email
  </button>
</body>
```
