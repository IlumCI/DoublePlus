import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Build-time flavor meta. index.html ships the default (copair) title,
 * description and icons; when VITE_BRAND selects another flavor this plugin
 * rewrites them in the emitted HTML so crawlers and the first paint carry the
 * right brand, not just the runtime override in main.tsx.
 */
const FLAVOR_META: Record<string, { title: string; description: string; icon?: string; ogImage?: string }> = {
  hammr: {
    title: "hammr | every coin goes under the hammer",
    description:
      "hammr. dutch-auction launchpad on Robinhood Chain: coins start at 10x and fall for one hour, then the hammer drops, liquidity locks, and holders earn the pair token on every trade.",
  },
  steadypads: {
    title: "steadypads | the stable launchpad",
    description:
      "steadypads. launch tokens into real markets on Stable. Creators earn 80% of every trade's pool fee.",
    icon: "/steadypads-mark.png",
  },
  arc: {
    title: "arcx | the stable launchpad on Arc",
    description:
      "arcx. launch tokens into real Uniswap markets on Arc. Every trade pays its creator in dollars, forever.",
    icon: "/steadypads-arc-mark.png",
  },
  base: {
    title: "basedstonk | launch a coin, earn real stock",
    description:
      "basedstonk.fun. Launch a memecoin on Base paired with a tokenized stock. Every trade rewards holders in that stock: hold the coin, earn NVIDIA, Apple, Google and more.",
    icon: "/stonk-logo.jpg",
    ogImage: "https://basedstonk.vercel.app/basedstonk-banner.jpg",
  },
};

function brandHtml(): Plugin {
  const meta = FLAVOR_META[String(process.env.VITE_BRAND ?? "")];
  return {
    name: "brand-html",
    transformIndexHtml(html) {
      if (!meta) return html;
      let out = html
        .replace(/<html lang="en">/, `<html lang="en" data-brand="${process.env.VITE_BRAND}">`)
        .replace(/<title>[^<]*<\/title>/, `<title>${meta.title}</title>`)
        .replace(/(<meta name="theme-color" content=")[^"]*(")/, `$1#060a09$2`)
        .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/, `$1${meta.description}$2`);
      // Open Graph / Twitter card so shared links show the brand banner.
      const og =
        `  <meta property="og:title" content="${meta.title}" />\n` +
        `  <meta property="og:description" content="${meta.description}" />\n` +
        `  <meta property="og:type" content="website" />\n` +
        (meta.ogImage
          ? `  <meta property="og:image" content="${meta.ogImage}" />\n` +
            `  <meta name="twitter:card" content="summary_large_image" />\n` +
            `  <meta name="twitter:image" content="${meta.ogImage}" />\n`
          : "") +
        `  <meta name="twitter:title" content="${meta.title}" />\n` +
        `  <meta name="twitter:description" content="${meta.description}" />\n`;
      out = out.replace("</head>", `${og}  </head>`);
      // koi.fun loads its type stack from the HTML head; CSS @import of remote
      // fonts is unreliable once bundled, so inject real <link> tags instead.
      if (String(process.env.VITE_BRAND) === "base") {
        out = out.replace(
          "</head>",
          `  <link rel="preconnect" href="https://fonts.googleapis.com" />\n` +
            `  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n` +
            `  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Inter+Tight:wght@400;600;700;800&family=Geist+Mono:wght@400;500;600&family=Bricolage+Grotesque:opsz,wdth,wght@48,75,400;48,75,600;48,75,700&display=swap" />\n  </head>`,
        );
      }
      if (meta.icon) {
        const type = meta.icon.endsWith(".svg") ? "image/svg+xml" : "image/png";
        out = out
          .replace(/<link rel="icon"[^>]*>/g, "")
          .replace(/<link rel="apple-touch-icon"[^>]*>/g, "")
          .replace(
            "</head>",
            `  <link rel="icon" type="${type}" href="${meta.icon}" />\n` +
              `  <link rel="apple-touch-icon" href="${meta.icon}" />\n  </head>`,
          );
      }
      return out;
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), brandHtml()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          wallet: ["wagmi", "viem"],
        },
      },
    },
  },
});
