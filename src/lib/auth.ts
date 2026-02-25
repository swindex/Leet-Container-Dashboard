import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { hasPermission, type Permission, type Role, PERMISSIONS, ROLES } from "./rbac.js";
import { resolveDataPath } from "./dataPaths.js";

const SESSION_COOKIE_NAME = "hs_session";
const DEFAULT_USERS_PATH = resolveDataPath("users.json");
const DEFAULT_TEST_USERS_PATH = path.resolve(process.cwd(), "data", "test", "users.json");
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOCK_TIME_MS = 10 * 60 * 1000;

type UserRecord = {
  id: string;
  username: string;
  passwordHash: string;
  role: Role;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ManagedUser = {
  id: string;
  username: string;
  role: Role;
  active: boolean;
  isOriginalAdmin: boolean;
  canDisable: boolean;
  canEnable: boolean;
  canDelete: boolean;
  createdAt: string;
  updatedAt: string;
};

type UsersFile = {
  users: UserRecord[];
};

function getOriginalAdminUser(users: UserRecord[]): UserRecord | null {
  const admins = users.filter((user) => user.role === ROLES.ADMIN);
  if (!admins.length) {
    return null;
  }

  return admins.reduce((earliest, current) => {
    if (current.createdAt < earliest.createdAt) {
      return current;
    }
    return earliest;
  });
}

export type AppSessionUser = {
  id: string;
  username: string;
  role: Role;
};

type SessionPayload = {
  user: AppSessionUser;
  csrfToken: string;
  activeServerId?: string;
  flashNotice?: string;
  flashError?: string;
};

declare global {
  namespace Express {
    interface Request {
      user?: AppSessionUser;
      csrfToken?: string;
      activeServerId?: string;
    }
  }
}

const loginAttempts = new Map<string, { count: number; firstAttemptAt: number; lockedUntil?: number }>();
const USERNAME_REGEX = /^[a-zA-Z0-9_.-]{3,50}$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

function getUsersFilePath(): string {
  return process.env.NODE_ENV === "test" ? DEFAULT_TEST_USERS_PATH : DEFAULT_USERS_PATH;
}

async function readUsersFile(usersFilePath = getUsersFilePath()): Promise<UsersFile> {
  const text = await fs.readFile(usersFilePath, "utf-8");
  const parsed = JSON.parse(text) as UsersFile;
  if (!parsed.users || !Array.isArray(parsed.users)) {
    throw new Error("Invalid users.json format: expected users array");
  }
  return parsed;
}

async function writeUsersFile(data: UsersFile, usersFilePath = getUsersFilePath()): Promise<void> {
  await fs.writeFile(usersFilePath, JSON.stringify(data, null, 2), "utf-8");
}

export async function isBootstrapAdminMode(): Promise<boolean> {
  const usersFile = await readUsersFile();
  return usersFile.users.length === 0;
}

async function createBootstrapAdmin(usernameInput: string, password: string): Promise<AppSessionUser | null> {
  const username = usernameInput.trim();
  if (!USERNAME_REGEX.test(username)) {
    throw new Error("Username must be 3-50 chars and use letters, numbers, _, ., or -");
  }

  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error("Password must be between 8 and 128 characters");
  }

  if (!password.trim()) {
    return null;
  }

  const usersFile = await readUsersFile();
  if (usersFile.users.length > 0) {
    return null;
  }

  const now = new Date().toISOString();
  const newUser: UserRecord = {
    id: crypto.randomUUID(),
    username,
    passwordHash: await bcrypt.hash(password, 12),
    role: ROLES.ADMIN,
    active: true,
    createdAt: now,
    updatedAt: now,
  };

  usersFile.users.push(newUser);
  await writeUsersFile(usersFile);

  return {
    id: newUser.id,
    username: newUser.username,
    role: newUser.role,
  };
}

function toCookieSession(payload: SessionPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

function fromCookieSession(value: string): SessionPayload | null {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf-8");
    const parsed = JSON.parse(decoded) as SessionPayload;
    if (!parsed.user?.id || !parsed.user?.username || !parsed.user?.role || !parsed.csrfToken) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function generateCsrfToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

function readCookieSecureEnv(): boolean {
  const raw = (process.env.COOKIE_SECURE || "").trim().toLowerCase();
  if (!raw) {
    return false;
  }

  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

function authCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: readCookieSecureEnv(),
    signed: true,
    maxAge: 8 * 60 * 60 * 1000,
  };
}

function clearAuthCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: readCookieSecureEnv(),
    signed: true,
  });
}

function normalizeIdentity(username: string, ip: string): string {
  return `${username.toLowerCase()}::${ip}`;
}

function canAttemptLogin(identity: string): { allowed: boolean; waitMs?: number } {
  const now = Date.now();
  const current = loginAttempts.get(identity);
  if (!current) {
    return { allowed: true };
  }
  if (current.lockedUntil && current.lockedUntil > now) {
    return { allowed: false, waitMs: current.lockedUntil - now };
  }
  if (now - current.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(identity);
    return { allowed: true };
  }
  return { allowed: true };
}

function registerFailedLogin(identity: string): void {
  const now = Date.now();
  const current = loginAttempts.get(identity);
  if (!current || now - current.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(identity, { count: 1, firstAttemptAt: now });
    return;
  }

  current.count += 1;
  if (current.count >= MAX_LOGIN_ATTEMPTS) {
    current.lockedUntil = now + LOCK_TIME_MS;
  }
  loginAttempts.set(identity, current);
}

function registerSuccessfulLogin(identity: string): void {
  loginAttempts.delete(identity);
}

export async function authenticateUser(username: string, password: string): Promise<AppSessionUser | null> {
  const normalized = username.trim().toLowerCase();
  if (!USERNAME_REGEX.test(normalized) || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return null;
  }

  const { users } = await readUsersFile();
  const user = users.find((u) => u.username.toLowerCase() === normalized && u.active);
  if (!user) {
    return null;
  }

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) {
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    role: user.role,
  };
}

export function setAuthSession(res: Response, user: AppSessionUser): string {
  const csrfToken = generateCsrfToken();
  const cookieValue = toCookieSession({ user, csrfToken });
  res.cookie(SESSION_COOKIE_NAME, cookieValue, authCookieOptions());
  return csrfToken;
}

function readSessionFromRequest(req: Request): SessionPayload | null {
  const cookieValue = req.signedCookies?.[SESSION_COOKIE_NAME] as string | undefined;
  if (!cookieValue) {
    return null;
  }
  return fromCookieSession(cookieValue);
}

function writeSessionToResponse(res: Response, req: Request, session: SessionPayload): void {
  const cookieValue = toCookieSession(session);
  res.cookie(SESSION_COOKIE_NAME, cookieValue, authCookieOptions());

  const signedCookies = (req.signedCookies ?? {}) as Record<string, string>;
  signedCookies[SESSION_COOKIE_NAME] = cookieValue;
  req.signedCookies = signedCookies;
}

export function setActiveServerSession(res: Response, req: Request, serverId: string): void {
  const session = readSessionFromRequest(req);
  if (!session) {
    throw new Error("Not authenticated");
  }

  const updated: SessionPayload = {
    ...session,
    activeServerId: serverId,
  };
  writeSessionToResponse(res, req, updated);
}

export function getActiveServerSessionId(req: Request): string | undefined {
  return readSessionFromRequest(req)?.activeServerId;
}

function normalizeFlashMessage(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, 180);
}

export function setFlashSession(
  res: Response,
  req: Request,
  flash: {
    notice?: string;
    error?: string;
  }
): void {
  const session = readSessionFromRequest(req);
  if (!session) {
    throw new Error("Not authenticated");
  }

  const notice = normalizeFlashMessage(flash.notice);
  const error = normalizeFlashMessage(flash.error);

  const updated: SessionPayload = {
    ...session,
    flashNotice: notice || undefined,
    flashError: error || undefined,
  };

  writeSessionToResponse(res, req, updated);
}

export function consumeFlashSession(
  res: Response,
  req: Request
): {
  notice: string;
  error: string;
} {
  const session = readSessionFromRequest(req);
  if (!session) {
    return { notice: "", error: "" };
  }

  const notice = normalizeFlashMessage(session.flashNotice);
  const error = normalizeFlashMessage(session.flashError);

  if (session.flashNotice || session.flashError) {
    const updated: SessionPayload = {
      ...session,
      flashNotice: undefined,
      flashError: undefined,
    };
    writeSessionToResponse(res, req, updated);
  }

  return { notice, error };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const cookieValue = req.signedCookies?.[SESSION_COOKIE_NAME] as string | undefined;
  if (!cookieValue) {
    res.redirect("/login");
    return;
  }

  const session = fromCookieSession(cookieValue);
  if (!session) {
    clearAuthCookie(res);
    res.redirect("/login");
    return;
  }

  req.user = session.user;
  req.csrfToken = session.csrfToken;
  req.activeServerId = session.activeServerId;
  next();
}

export function ensureCsrf(req: Request, res: Response, next: NextFunction): void {
  const tokenFromForm = typeof req.body?._csrf === "string" ? req.body._csrf : "";
  const sessionToken = req.csrfToken;

  if (!sessionToken || !tokenFromForm) {
    res.status(403).send("Invalid CSRF token");
    return;
  }

  const sessionBuffer = Buffer.from(sessionToken);
  const formBuffer = Buffer.from(tokenFromForm);

  if (
    sessionBuffer.length !== formBuffer.length ||
    !crypto.timingSafeEqual(sessionBuffer, formBuffer)
  ) {
    res.status(403).send("Invalid CSRF token");
    return;
  }
  next();
}

export function requirePermission(permission: Permission): RequestHandler {
  return (req, res, next) => {
    if (!req.user) {
      res.redirect("/login");
      return;
    }
    if (!hasPermission(req.user.role, permission)) {
      res.status(403).send("Forbidden");
      return;
    }
    next();
  };
}

export function getPermissionFlags(user?: AppSessionUser): {
  canViewContainers: boolean;
  canRestartContainers: boolean;
  canRestartHost: boolean;
  canManageUsers: boolean;
  canSwitchServers: boolean;
  canManageServers: boolean;
  canManageSettings: boolean;
} {
  if (!user) {
    return {
      canViewContainers: false,
      canRestartContainers: false,
      canRestartHost: false,
      canManageUsers: false,
      canSwitchServers: false,
      canManageServers: false,
      canManageSettings: false,
    };
  }

  return {
    canViewContainers: hasPermission(user.role, PERMISSIONS.CONTAINERS_VIEW),
    canRestartContainers: hasPermission(user.role, PERMISSIONS.CONTAINERS_RESTART),
    canRestartHost: hasPermission(user.role, PERMISSIONS.HOST_RESTART),
    canManageUsers: hasPermission(user.role, PERMISSIONS.USERS_MANAGE),
    canSwitchServers: hasPermission(user.role, PERMISSIONS.SERVERS_SWITCH),
    canManageServers: hasPermission(user.role, PERMISSIONS.SERVERS_MANAGE),
    canManageSettings: hasPermission(user.role, PERMISSIONS.SETTINGS_MANAGE),
  };
}

export async function listManagedUsers(actorUserId?: string): Promise<ManagedUser[]> {
  const usersFile = await readUsersFile();
  const originalAdmin = getOriginalAdminUser(usersFile.users);

  return usersFile.users.map((user) => ({
    id: user.id,
    username: user.username,
    role: user.role,
    active: user.active,
    isOriginalAdmin: originalAdmin?.id === user.id,
    canDisable: user.active && user.id !== actorUserId && originalAdmin?.id !== user.id,
    canEnable: !user.active && user.id !== actorUserId && originalAdmin?.id !== user.id,
    canDelete: user.id !== actorUserId && originalAdmin?.id !== user.id,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }));
}

export async function createManagedUser(input: {
  username: string;
  password: string;
  role: Role;
}): Promise<void> {
  const username = input.username.trim();
  const normalizedUsername = username.toLowerCase();
  const password = input.password;

  if (!USERNAME_REGEX.test(username)) {
    throw new Error("Username must be 3-50 chars and use letters, numbers, _, ., or -");
  }
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error("Password must be between 8 and 128 characters");
  }
  if (!Object.values(ROLES).includes(input.role)) {
    throw new Error("Invalid role");
  }

  const usersFile = await readUsersFile();
  const existing = usersFile.users.find((user) => user.username.toLowerCase() === normalizedUsername);
  if (existing) {
    throw new Error("Username already exists");
  }

  const now = new Date().toISOString();
  usersFile.users.push({
    id: crypto.randomUUID(),
    username,
    passwordHash: await bcrypt.hash(password, 12),
    role: input.role,
    active: true,
    createdAt: now,
    updatedAt: now,
  });

  await writeUsersFile(usersFile);
}

export async function setManagedUserActiveStatus(input: {
  userId: string;
  active: boolean;
  actorUserId: string;
}): Promise<void> {
  const usersFile = await readUsersFile();
  const target = usersFile.users.find((user) => user.id === input.userId);
  const originalAdmin = getOriginalAdminUser(usersFile.users);
  if (!target) {
    throw new Error("User not found");
  }
  if (target.id === input.actorUserId) {
    throw new Error("You cannot disable your own account");
  }
  if (originalAdmin?.id === target.id) {
    throw new Error("Cannot disable the original admin");
  }

  if (!input.active && target.role === ROLES.ADMIN && target.active) {
    const activeAdminCount = usersFile.users.filter((user) => user.role === ROLES.ADMIN && user.active).length;
    if (activeAdminCount <= 1) {
      throw new Error("Cannot disable the last active admin");
    }
  }

  target.active = input.active;
  target.updatedAt = new Date().toISOString();
  await writeUsersFile(usersFile);
}

export async function deleteManagedUser(input: { userId: string; actorUserId: string }): Promise<void> {
  const usersFile = await readUsersFile();
  const target = usersFile.users.find((user) => user.id === input.userId);
  const originalAdmin = getOriginalAdminUser(usersFile.users);
  if (!target) {
    throw new Error("User not found");
  }
  if (target.id === input.actorUserId) {
    throw new Error("You cannot delete your own account");
  }
  if (originalAdmin?.id === target.id) {
    throw new Error("Cannot delete the original admin");
  }

  if (target.role === ROLES.ADMIN && target.active) {
    const activeAdminCount = usersFile.users.filter((user) => user.role === ROLES.ADMIN && user.active).length;
    if (activeAdminCount <= 1) {
      throw new Error("Cannot remove the last active admin");
    }
  }

  usersFile.users = usersFile.users.filter((user) => user.id !== input.userId);
  await writeUsersFile(usersFile);
}

export async function updateManagedUser(input: {
  userId: string;
  actorUserId: string;
  role: Role;
  password?: string;
}): Promise<void> {
  if (!Object.values(ROLES).includes(input.role)) {
    throw new Error("Invalid role");
  }

  if (
    typeof input.password === "string" &&
    input.password.length > 0 &&
    (input.password.length < MIN_PASSWORD_LENGTH || input.password.length > MAX_PASSWORD_LENGTH)
  ) {
    throw new Error("Password must be between 8 and 128 characters");
  }

  const usersFile = await readUsersFile();
  const target = usersFile.users.find((user) => user.id === input.userId);
  const originalAdmin = getOriginalAdminUser(usersFile.users);
  if (!target) {
    throw new Error("User not found");
  }

  if (target.id === input.actorUserId) {
    throw new Error("You cannot edit your own account");
  }

  if (originalAdmin?.id === target.id) {
    throw new Error("Cannot edit the original admin");
  }

  if (target.role === ROLES.ADMIN && input.role !== ROLES.ADMIN && target.active) {
    const activeAdminCount = usersFile.users.filter((user) => user.role === ROLES.ADMIN && user.active).length;
    if (activeAdminCount <= 1) {
      throw new Error("Cannot remove the last active admin role");
    }
  }

  target.role = input.role;
  if (typeof input.password === "string" && input.password.length > 0) {
    target.passwordHash = await bcrypt.hash(input.password, 12);
  }
  target.updatedAt = new Date().toISOString();

  await writeUsersFile(usersFile);
}

export async function initAdminFromEnv(): Promise<void> {
  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD;
  const role = (process.env.ADMIN_ROLE?.trim().toLowerCase() as Role | undefined) || ROLES.ADMIN;

  if (!username || !password) {
    console.log("ADMIN_USERNAME/ADMIN_PASSWORD not provided; skipping admin bootstrap.");
    return;
  }
  if (password.length < 12) {
    throw new Error("ADMIN_PASSWORD must be at least 12 characters.");
  }

  const usersFile = await readUsersFile();
  const existing = usersFile.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  const now = new Date().toISOString();
  const passwordHash = await bcrypt.hash(password, 12);

  if (existing) {
    existing.passwordHash = passwordHash;
    existing.role = role;
    existing.active = true;
    existing.updatedAt = now;
  } else {
    usersFile.users.push({
      id: crypto.randomUUID(),
      username,
      passwordHash,
      role,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  await writeUsersFile(usersFile);
  console.log(`Admin user '${username}' initialized/updated successfully.`);
}

export async function handleLogin(req: Request, res: Response): Promise<void> {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const isBootstrapMode = await isBootstrapAdminMode();

  const bootstrapUser = await createBootstrapAdmin(username, password);
  if (bootstrapUser) {
    setAuthSession(res, bootstrapUser);
    res.redirect("/");
    return;
  }

  const ip = req.ip || "unknown";
  const identity = normalizeIdentity(username, ip);

  const allowed = canAttemptLogin(identity);
  if (!allowed.allowed) {
    const waitSeconds = Math.ceil((allowed.waitMs ?? 0) / 1000);
    res.status(429).render("login", {
      error: `Too many attempts. Try again in ${waitSeconds}s.`,
      username,
      isBootstrapMode,
    });
    return;
  }

  const user = await authenticateUser(username, password);
  if (!user) {
    registerFailedLogin(identity);
    res.status(401).render("login", {
      error: "Invalid credentials",
      username,
      isBootstrapMode,
    });
    return;
  }

  registerSuccessfulLogin(identity);
  setAuthSession(res, user);
  res.redirect("/");
}

export function logout(req: Request, res: Response): void {
  void req;
  clearAuthCookie(res);
  res.redirect("/login");
}
