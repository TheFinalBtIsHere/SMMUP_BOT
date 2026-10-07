import { MongoClient, type Db } from "mongodb";
import { DB_NAME, MONGODB_URI } from "../config.js";

let mongoClient: MongoClient | null = null;
let db: Db | null = null;

export async function getDatabase(): Promise<Db> {
  if (db) return db;
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is not set in environment variables");
  }
  mongoClient = new MongoClient(MONGODB_URI, {
    maxPoolSize: 10,
    minPoolSize: 1,
    serverSelectionTimeoutMS: 15_000,
    connectTimeoutMS: 15_000,
    socketTimeoutMS: 30_000,
  });
  try {
    await mongoClient.connect();
  } catch (error) {
    await mongoClient.close().catch(() => {});
    mongoClient = null;
    throw error;
  }
  db = mongoClient.db(DB_NAME);
  console.log(`[AdminBot] Connected to MongoDB Atlas (${DB_NAME})`);
  return db;
}

export function getMongoClient(): MongoClient | null {
  return mongoClient;
}

export async function closeDatabase(): Promise<void> {
  await mongoClient?.close();
  mongoClient = null;
  db = null;
}
