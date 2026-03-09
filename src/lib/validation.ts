import Joi from "joi";
import { ROLES } from "./rbac.js";

// ============================================================================
// Common Schemas
// ============================================================================

export const usernameSchema = Joi.string()
  .min(3)
  .max(50)
  .pattern(/^[a-zA-Z0-9_.-]+$/)
  .required()
  .messages({
    "string.pattern.base": "Username must contain only letters, numbers, underscores, dots, and hyphens",
    "string.min": "Username must be at least {#limit} characters long",
    "string.max": "Username must be at most {#limit} characters long",
    "any.required": "Username is required",
  });

export const passwordSchema = Joi.string()
  .min(8)
  .max(128)
  .required()
  .messages({
    "string.min": "Password must be at least {#limit} characters long",
    "string.max": "Password must be at most {#limit} characters long",
    "any.required": "Password is required",
  });

export const optionalPasswordSchema = Joi.string()
  .min(8)
  .max(128)
  .allow("")
  .optional()
  .messages({
    "string.min": "Password must be at least {#limit} characters long",
    "string.max": "Password must be at most {#limit} characters long",
  });

export const roleSchema = Joi.string()
  .valid(...Object.values(ROLES))
  .required()
  .messages({
    "any.only": "Invalid role",
    "any.required": "Role is required",
  });

// ============================================================================
// Login/Authentication Schemas
// ============================================================================

export const loginSchema = Joi.object({
  username: usernameSchema,
  password: passwordSchema,
});

export const bootstrapAdminSchema = Joi.object({
  username: usernameSchema,
  password: passwordSchema,
});

// ============================================================================
// User Management Schemas
// ============================================================================

export const createUserSchema = Joi.object({
  username: usernameSchema,
  password: passwordSchema,
  role: roleSchema,
});

export const updateUserSchema = Joi.object({
  role: roleSchema,
  password: optionalPasswordSchema,
});

export const userIdSchema = Joi.string()
  .uuid()
  .required()
  .messages({
    "string.guid": "Invalid user ID",
    "any.required": "User ID is required",
  });

// ============================================================================
// Server Management Schemas
// ============================================================================

export const serverNameSchema = Joi.string()
  .min(1)
  .max(100)
  .required()
  .messages({
    "string.min": "Server name is required",
    "string.max": "Server name must be at most {#limit} characters long",
    "any.required": "Server name is required",
  });

/**
 * Validates server hostnames with strict pattern matching to prevent command injection.
 * 
 * Security rationale:
 * - Accepts RFC 1123 compliant hostnames (e.g., example.com, sub.example.com)
 * - Accepts IPv4 addresses (e.g., 192.168.1.1)
 * - Accepts IPv6 addresses (e.g., 2001:db8::1, [::1], fe80::1)
 * - BLOCKS special shell characters: ; | & $ ` ' " \ ( ) < > etc.
 * - Prevents SSH command injection attacks
 * 
 * Design philosophy: Security-focused validation (not strict RFC compliance)
 * - Primary goal: Block shell metacharacters that could enable command injection
 * - Secondary goal: Accept valid hostnames/IPs (OS network stack validates them anyway)
 * 
 * Examples:
 * ✅ Valid: "example.com", "192.168.1.100", "server-01.local", "[::1]", "2001:db8::1"
 * ❌ Invalid: "example.com; rm -rf /", "$(whoami).com", "test|nc"
 */
export const serverHostSchema = Joi.string()
  .min(1)
  .max(255)
  .pattern(/^(?:(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?|(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)|\[?[0-9a-fA-F:]+\]?)$/)
  .required()
  .messages({
    "string.pattern.base": "Host must be a valid hostname (RFC 1123), IPv4, or IPv6 address. No special characters allowed.",
    "string.min": "Host is required",
    "string.max": "Host must be at most {#limit} characters long",
    "any.required": "Host is required",
  });

/**
 * Validates SSH usernames following POSIX/Linux username conventions.
 * 
 * Security rationale:
 * - Must start with lowercase letter or underscore (standard Unix convention)
 * - Only allows lowercase letters, digits, underscores, hyphens
 * - Maximum 32 characters (Linux USERNAME_MAX_LENGTH)
 * - BLOCKS uppercase letters, spaces, special characters
 * - Prevents SSH command injection and shell escape attempts
 * 
 * Examples:
 * ✅ Valid: "root", "ubuntu", "deploy_user", "admin-01", "_service"
 * ❌ Invalid: "Root", "user name", "admin;", "$(whoami)", "user@host"
 */
export const serverUsernameSchema = Joi.string()
  .min(1)
  .max(32)
  .pattern(/^[a-z_][a-z0-9_-]{0,31}$/)
  .required()
  .messages({
    "string.pattern.base": "Username must start with a lowercase letter or underscore, and contain only lowercase letters, digits, underscores, and hyphens",
    "string.min": "Username is required",
    "string.max": "Username must be at most {#limit} characters long",
    "any.required": "Username is required",
  });

export const serverPasswordSchema = Joi.string()
  .min(1)
  .max(255)
  .required()
  .messages({
    "string.min": "Password is required",
    "string.max": "Password must be at most {#limit} characters long",
    "any.required": "Password is required",
  });

export const optionalServerPasswordSchema = Joi.string()
  .min(1)
  .max(255)
  .allow("")
  .optional()
  .messages({
    "string.min": "Password is required if provided",
    "string.max": "Password must be at most {#limit} characters long",
  });

export const serverEnabledSchema = Joi.boolean()
  .default(true)
  .messages({
    "boolean.base": "Enabled must be a boolean value",
  });

export const createServerSchema = Joi.object({
  name: serverNameSchema,
  host: serverHostSchema,
  username: serverUsernameSchema,
  password: serverPasswordSchema,
  enabled: serverEnabledSchema,
});

export const updateServerSchema = Joi.object({
  name: serverNameSchema,
  host: serverHostSchema,
  username: serverUsernameSchema,
  password: optionalServerPasswordSchema,
  enabled: serverEnabledSchema,
});

export const updateLocalServerSchema = Joi.object({
  name: serverNameSchema,
  host: serverHostSchema,
  username: Joi.string().allow("").optional(),
  password: Joi.string().allow("").optional(),
  enabled: serverEnabledSchema,
});

export const serverIdSchema = Joi.string()
  .min(1)
  .required()
  .messages({
    "string.min": "Server ID is required",
    "any.required": "Server ID is required",
  });

// ============================================================================
// Dashboard Settings Schemas
// ============================================================================

export const appTitleSchema = Joi.string()
  .min(1)
  .max(120)
  .default("Leet Container Dashboard")
  .messages({
    "string.min": "App title is required",
    "string.max": "App title must be at most {#limit} characters long",
  });

export const appSloganSchema = Joi.string()
  .max(220)
  .allow("")
  .default("Monitor and control containers on your network.")
  .messages({
    "string.max": "App slogan must be at most {#limit} characters long",
  });

export const themeSchema = Joi.string()
  .valid("light", "dark")
  .default("dark")
  .messages({
    "any.only": "Theme must be either 'light' or 'dark'",
  });

export const booleanSettingSchema = Joi.optional()
  .default(false)
  .custom((value) => {
    // Convert "on" to true, undefined/anything else to false
    return value === "on";
  });

export const dashboardRefreshIntervalSchema = Joi.number()
  .integer()
  .min(3000)
  .max(60000)
  .default(5000)
  .messages({
    "number.base": "Dashboard refresh interval must be a number",
    "number.integer": "Dashboard refresh interval must be an integer",
    "number.min": "Dashboard refresh interval must be at least {#limit}ms (3 seconds)",
    "number.max": "Dashboard refresh interval must be at most {#limit}ms (60 seconds)",
  });

export const defaultViewPageSchema = Joi.string()
  .valid("dashboard", "launchpad")
  .default("dashboard")
  .messages({
    "any.only": "Default view page must be either 'dashboard' or 'launchpad'",
  });

export const updateSettingsSchema = Joi.object({
  appTitle: appTitleSchema,
  appSlogan: appSloganSchema,
  theme: themeSchema,
  hideAttributionFooter: booleanSettingSchema.default(false),
  showContainerResources: booleanSettingSchema,
  showServerResources: booleanSettingSchema,
  showImageName: booleanSettingSchema,
  showContainerHash: booleanSettingSchema,
  dashboardRefreshInterval: dashboardRefreshIntervalSchema,
  defaultViewPage: defaultViewPageSchema,
});

// ============================================================================
// Helper Functions
// ============================================================================

export type ValidationResult<T> = 
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Validates data against a Joi schema and returns a typed result
 */
export function validate<T>(schema: Joi.Schema, data: unknown): ValidationResult<T> {
  const result = schema.validate(data, {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });

  if (result.error) {
    const errorMessage = result.error.details
      .map((detail) => detail.message)
      .join("; ");
    return { success: false, error: errorMessage };
  }

  return { success: true, data: result.value as T };
}

/**
 * Validates data and throws an error if validation fails
 */
export function validateOrThrow<T>(schema: Joi.Schema, data: unknown): T {
  const result = validate<T>(schema, data);
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.data;
}
