import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

/**
 * Cache the connection across hot-reloads in dev and across warm serverless
 * invocations in prod, so we don't open a new connection pool per request.
 */
type CachedConnection = { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null };
declare global {
  // eslint-disable-next-line no-var
  var _mongooseCache: CachedConnection | undefined;
}

const cache: CachedConnection = global._mongooseCache || { conn: null, promise: null };
if (!global._mongooseCache) global._mongooseCache = cache;

export async function connectDB(): Promise<typeof mongoose> {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is not set. Copy web/.env.example to web/.env.local and fill it in.");
  }
  if (cache.conn) return cache.conn;
  if (!cache.promise) {
    cache.promise = mongoose.connect(MONGODB_URI, { bufferCommands: false });
  }
  cache.conn = await cache.promise;
  return cache.conn;
}
