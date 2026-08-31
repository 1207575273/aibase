-- CreateTable
CREATE TABLE "sys_user" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

-- CreateTable
CREATE TABLE "sys_role" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "superAdmin" BOOLEAN NOT NULL DEFAULT false,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "dataScope" TEXT NOT NULL DEFAULT 'ALL',
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

-- CreateTable
CREATE TABLE "sys_user_role" (
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    PRIMARY KEY ("userId", "roleId"),
    CONSTRAINT "sys_user_role_userId_fkey" FOREIGN KEY ("userId") REFERENCES "sys_user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "sys_user_role_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "sys_role" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "sys_role_permission" (
    "roleId" TEXT NOT NULL,
    "code" TEXT NOT NULL,

    PRIMARY KEY ("roleId", "code"),
    CONSTRAINT "sys_role_permission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "sys_role" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "sys_user_username_key" ON "sys_user"("username");

-- CreateIndex
CREATE INDEX "sys_user_status_idx" ON "sys_user"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sys_role_code_key" ON "sys_role"("code");

-- CreateIndex
CREATE INDEX "sys_user_role_roleId_idx" ON "sys_user_role"("roleId");
