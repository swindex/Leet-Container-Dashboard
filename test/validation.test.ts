import { describe, expect, it } from "vitest";
import { 
  validate, 
  serverHostSchema, 
  serverUsernameSchema,
  createServerSchema 
} from "../src/lib/validation.js";

describe("Server validation schemas", () => {
  describe("serverHostSchema", () => {
    it("accepts valid hostnames", () => {
      const validHosts = [
        "localhost",
        "example.com",
        "sub.example.com",
        "server-01.local",
        "my-server.example.co.uk",
      ];

      for (const host of validHosts) {
        const result = validate(serverHostSchema, host);
        expect(result.success).toBe(true);
      }
    });

    it("accepts valid IPv4 addresses", () => {
      const validIPs = [
        "192.168.1.1",
        "10.0.0.99",
        "127.0.0.1",
        "172.16.0.1",
        "255.255.255.255",
      ];

      for (const ip of validIPs) {
        const result = validate(serverHostSchema, ip);
        expect(result.success).toBe(true);
      }
    });

    it("accepts valid IPv6 addresses", () => {
      const validIPv6 = [
        "2001:db8::1",
        "::1",
        "[::1]",
        "fe80::1",
        "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
        "[2001:db8::8a2e:370:7334]",
      ];

      for (const ip of validIPv6) {
        const result = validate(serverHostSchema, ip);
        expect(result.success).toBe(true);
      }
    });


    it("rejects hostnames with shell injection attempts", () => {
      const maliciousHosts = [
        "example.com; rm -rf /",
        "$(whoami).com",
        "test|nc",
        "host`whoami`",
        "host'test",
        'host"test',
        "host\\test",
        "host&test",
        "host>test",
        "host<test",
      ];

      for (const host of maliciousHosts) {
        const result = validate(serverHostSchema, host);
        expect(result.success).toBe(false);
      }
    });
  });

  describe("serverUsernameSchema", () => {
    it("accepts valid Unix usernames", () => {
      const validUsernames = [
        "root",
        "ubuntu",
        "admin",
        "deploy",
        "service",
        "_system",
        "user123",
        "web-admin",
        "deploy_user",
        "ci-runner",
      ];

      for (const username of validUsernames) {
        const result = validate(serverUsernameSchema, username);
        if (!result.success) {
          console.log(`Failed for "${username}": ${result.error}`);
        }
        expect(result.success).toBe(true);
      }
    });

    it("rejects usernames with uppercase letters", () => {
      const invalidUsernames = ["Root", "ADMIN", "Ubuntu"];

      for (const username of invalidUsernames) {
        const result = validate(serverUsernameSchema, username);
        expect(result.success).toBe(false);
      }
    });

    it("rejects usernames with special characters", () => {
      const invalidUsernames = [
        "admin;",
        "$(whoami)",
        "user@host",
        "user name",
        "user|test",
        "user&test",
      ];

      for (const username of invalidUsernames) {
        const result = validate(serverUsernameSchema, username);
        expect(result.success).toBe(false);
      }
    });

    it("rejects usernames starting with digits", () => {
      const result = validate(serverUsernameSchema, "123user");
      expect(result.success).toBe(false);
    });

    it("accepts usernames with exactly 32 characters", () => {
      const username = "a" + "b".repeat(31); // 32 chars total
      const result = validate(serverUsernameSchema, username);
      expect(result.success).toBe(true);
    });

    it("rejects usernames longer than 32 characters", () => {
      const username = "a" + "b".repeat(32); // 33 chars total
      const result = validate(serverUsernameSchema, username);
      expect(result.success).toBe(false);
    });
  });

  describe("createServerSchema", () => {
    it("accepts valid server configuration from test", () => {
      const serverData = {
        name: "Encrypted Remote",
        host: "10.0.0.99",
        username: "root",
        password: "TopSecret#Pass123",
        enabled: true,
      };

      const result = validate(createServerSchema, serverData);
      if (!result.success) {
        console.log("Validation error:", result.error);
      }
      expect(result.success).toBe(true);
    });
  });
});
