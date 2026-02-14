---
title: "How I fixed the Nutrient Web SDK ChunkLoadError in Next.js on Netlify"
summary: "My experience building  with Nutrient Web SDK and how to work around the ChunkLoadError"
author: "Daniel Torkura"
date: "2026-02-14"
description: "How I fixed the Nutrient Web SDK ChunkLoadError in Next.js on Netlify"
tags: ["ai", "nextjs", "coding"]
seo:
  title: "How I Fixed the Nutrient Web SDK ChunkLoadError in Next.js on Netlify"
  description: "How I Fixed the Nutrient Web SDK ChunkLoadError in Next.js on Netlify"
  keywords: ["ai", "nextjs", "coding"]
---

So I just spent way too long debugging a `ChunkLoadError` with the Nutrient Web SDK (formerly PSPDFKit) in a Next.js app deployed to Netlify. Figured I'd write this up because I couldn't find a clear answer anywhere and I know other people are hitting this.

## The Problem

After deploying to Netlify, the PDF viewer refused to load. The browser console showed:

```
ChunkLoadError: Loading chunk 451 failed.
(missing: https://myapp.netlify.app/_next/static/chunks/471f996b.26d42df778d747e8.js)
```

Locally, everything worked fine. I was able to spin it up in minutes. Only production was broken. I f*cked up assuming that production would be similar to my local environment.

## Digging deeper to understand the problem

When you build a modern web app, tools like [webpack](https://webpack.js.org/) (which Next.js uses under the hood) take all your JavaScript and split it into smaller files called "chunks." The browser downloads these chunks as needed instead of loading everything at once. This is normally great for performance.

The Nutrient Web SDK is a PDF viewer library. But the thing is it was *already built and packaged* by Nutrient's own team using webpack (a bundler) before you ever installed it. 

Here's where the problem starts: when you install the SDK via npm and import it the normal way, Next.js's webpack tries to **take apart that engine and rebuild it**. It opens up Nutrient's pre-built bundle and sees what looks like chunk-loading instructions inside. But those instructions are Nutrient's internal wiring, they tell the viewer how to load its own pieces (WASM files, workers, locale packs) from your `public/` folder.

Next.js's webpack doesn't know that. It thinks, "Oh, these look like chunks I need to create," and registers them in its own system. But since they're ghost references from someone else's build, it never actually creates the files. The browser then tries to download a chunk that was registered but never generated — and you get a 404 and `ChunkLoadError`.

In summary, Next.js's bundler (webpack) is trying to re-bundle an already-bundled library and getting confused by its internals.

## What I tried (for so many hours)

### `transpilePackages` Only

The official Nutrient docs say to add this to `next.config.mjs`:

```js
transpilePackages: ['@nutrient-sdk/viewer']
```

This tells Next.js to process the package through its compiler (SWC). This makes webpack parse the entire 6MB bundle, which is exactly what triggers the ghost chunk problem. Error - ChunkLoadError.

### Remove `transpilePackages`

"Fine, I just won't transpile it." But the Nutrient bundle uses modern JavaScript syntax like `new foo?.bar()` (optional chaining with `new`). Browsers need this transpiled. Without `transpilePackages`, the browser can't parse the raw code. New error - `SyntaxError: Invalid optional chain from new expression`.

### `transpilePackages` + webpack `noParse`

I thought: let SWC transpile the syntax, but tell webpack to skip its dependency analysis step using `noParse`. Clever, right? Turns out webpack's `noParse` also skips the step that rewires `require()` calls to work in the browser. The Nutrient bundle uses `require()` internally (it's a UMD module), so it crashes. New error - `ReferenceError: require is not defined`.

Every path through webpack was a dead end. The library is a webpack bundle *inside* webpack. You can't win.

## So what worked?

Easy. I stopped letting webpack touch it. Load it as a plain old script tag. Instead of fighting with webpack to handle a pre-built bundle it was never designed to process, we just don't. The viewer loads as a static file. Its internal webpack runtime handles its own chunk loading from `nutrient-viewer-lib/`. Next.js's webpack never sees it.

No ghost chunks. No transpilation conflicts. No module system mismatches.

Here's what I did:

### Copy the standalone bundle to your public folder

You're probably already copying the viewer's runtime assets (WASM, workers, etc.) in a prebuild step. Add the main bundle too.

In `package.json`, update your prebuild script:

```json
{
  "scripts": {
    "prebuild": "mkdir -p public/nutrient-viewer-lib && cp -rv node_modules/@nutrient-sdk/viewer/dist/nutrient-viewer-lib/* public/nutrient-viewer-lib/ && cp node_modules/@nutrient-sdk/viewer/dist/nutrient-viewer.js public/nutrient-viewer.js",
    "build": "npm run prebuild && next build"
  }
}
```

That extra `&& cp ... nutrient-viewer.js public/nutrient-viewer.js` at the end is the key new bit.

### Clean up next.config.mjs

Remove `transpilePackages` and any webpack customisation. You don't need it anymore because webpack isn't processing the viewer at all.

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
```

Feels good to delete config, doesn't it?

### Load the viewer via a script tag

In your viewer component, replace the dynamic `import()` with Next.js's `<Script>` component. The Nutrient bundle is a UMD module — when loaded as a script, it automatically sets `window.NutrientViewer`.

**Before (broken):**

```tsx
useEffect(() => {
  if (!viewerUrl || !containerRef.current) return;

  (async () => {
    const NutrientViewer = (await import("@nutrient-sdk/viewer")).default;
    // ... initialize viewer
  })();
}, [viewerUrl]);
```

**After (working):**

```tsx
import Script from "next/script";

// Add a state to track when the script has loaded
const [sdkLoaded, setSdkLoaded] = useState(false);

useEffect(() => {
  // Don't run until BOTH the script is loaded AND we have a URL
  if (!sdkLoaded || !viewerUrl || !containerRef.current) return;

  (async () => {
    // Grab it from the window — no webpack involved
    const NutrientViewer = (window as any).NutrientViewer;
    // ... initialize viewer (rest of the code stays the same)
  })();
}, [sdkLoaded, viewerUrl]);

// In your JSX — make sure this is always rendered (not inside a conditional)
return (
  <div>
    <Script
      src="/nutrient-viewer.js"
      strategy="afterInteractive"
      onLoad={() => setSdkLoaded(true)}
    />
    {/* ... rest of your UI */}
  </div>
);
```

A couple of things to watch out for:

- Always render the `<Script>` tag. If you have an error state with an early `return`, make sure the `<Script>` is included in *both* the error and success renders. Otherwise the SDK never loads and "Retry" won't work.
- `next/script` deduplicates by `src`, so even if the component re-renders, it only fetches the file once.

### Fix the `baseUrl`

When loaded as a standalone script, the Nutrient viewer resolves its asset paths as `baseUrl + "nutrient-viewer-lib/" + filename`. It appends the `nutrient-viewer-lib/` part automatically.

So if your assets are at `/nutrient-viewer-lib/chunk-standalone-*.js`, the `baseUrl` needs to be the *parent directory* — just `/`.

```js
const instance = await NutrientViewer.load({
  container,
  document: pdfUrl,
  baseUrl: `${window.location.origin}/`,  // NOT /nutrient-viewer-lib/
  theme: "LIGHT",
});
```

If you set `baseUrl` to `/nutrient-viewer-lib/`, you'll get a double-prefix `/nutrient-viewer-lib/nutrient-viewer-lib/chunk-...` and a fresh round of 404s.

Hope this saves someone else a few hours. Happy building. While you're still here, check out the tool I built using the nutrient web SDK. It is a simple tool for [understanding your finances](https://statementchat.netlify.app/upload).



Quick aside on two tools that matter here:
- **Webpack** is a bundler. It takes many separate files and combines them into a small number of output files ("chunks") for the browser.
- **SWC** is a transpiler. It converts modern JavaScript syntax (like optional chaining `foo?.bar`) into older syntax that all browsers understand.


