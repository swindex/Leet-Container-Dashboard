export const PERMISSIONS = {
  CONTAINERS_VIEW: "containers:view",
  CONTAINERS_RESTART: "containers:restart",
  HOST_RESTART: "host:restart",
  USERS_MANAGE: "users:manage",
  SERVERS_SWITCH: "servers:switch",
  SERVERS_MANAGE: "servers:manage",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ROLES = {
  VIEWER: "viewer",
  OPERATOR: "operator",
  ADMIN: "admin",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  [ROLES.VIEWER]: [PERMISSIONS.CONTAINERS_VIEW],
  [ROLES.OPERATOR]: [PERMISSIONS.CONTAINERS_VIEW, PERMISSIONS.CONTAINERS_RESTART, PERMISSIONS.SERVERS_SWITCH],
  [ROLES.ADMIN]: [
    PERMISSIONS.CONTAINERS_VIEW,
    PERMISSIONS.CONTAINERS_RESTART,
    PERMISSIONS.HOST_RESTART,
    PERMISSIONS.USERS_MANAGE,
    PERMISSIONS.SERVERS_SWITCH,
    PERMISSIONS.SERVERS_MANAGE,
  ],
};

export function getPermissionsForRole(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return getPermissionsForRole(role).includes(permission);
}
