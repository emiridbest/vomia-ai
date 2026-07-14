/** @type {import('next').NextConfig} */
const nextConfig = {
  // viem / mongoose pull in Node built-ins that Next tries to
  // bundle for the edge by default; keep API routes on the Node runtime.
  experimental: {
    serverComponentsExternalPackages: ["mongoose"],
  },
};

export default nextConfig;
