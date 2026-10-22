-- CreateEnum
CREATE TYPE "BuildingUse" AS ENUM ('residential', 'office', 'mixed_use', 'retail');

-- CreateTable
CREATE TABLE "Building" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "colonia" TEXT NOT NULL,
    "alcaldia" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "city" TEXT NOT NULL DEFAULT 'Ciudad de México',
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "use" "BuildingUse" NOT NULL,
    "yearBuilt" INTEGER NOT NULL,
    "floors" INTEGER NOT NULL,
    "basementLevels" INTEGER NOT NULL DEFAULT 0,
    "units" INTEGER NOT NULL,
    "grossAreaM2" INTEGER NOT NULL,
    "lotAreaM2" INTEGER,
    "parkingSpaces" INTEGER NOT NULL DEFAULT 0,
    "elevators" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Building_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Building_slug_key" ON "Building"("slug");
