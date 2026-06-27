import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as any

export const prisma = globalForPrisma.prisma ?? new PrismaClient()

globalForPrisma.prisma = prisma
