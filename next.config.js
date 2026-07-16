/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static export: the app is 100% client-rendered, so we ship it as plain
  // static files served by the Cloudflare Worker (see wrangler.toml). Output
  // goes to ./out.
  output: 'export',
};

module.exports = nextConfig;
