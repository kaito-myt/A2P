import { PrismaClient } from './generated/index.js';

// docs/05 §13 #1: Next.js dev mode のホットリロードで PrismaClient が多重生成されないようにする。
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ log: ['warn', 'error'] });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export type { PrismaClient } from './generated/index.js';
export * from './generated/index.js';
export * from './src/ab-comparison.js';
