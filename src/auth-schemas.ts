import type { Schema } from "./openapi/types";

export const credentialsSchema: Schema = {
  jsonSchema: {
    type: "object",
    required: ["email", "password"],
    properties: {
      email: { type: "string", format: "email" },
      password: { type: "string", minLength: 4, maxLength: 128 },
    },
    additionalProperties: false,
  },
  safeParse(value) {
    const body = value as Record<string, unknown> | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const issues: Array<{ path: string[]; message: string; code: string }> = [];
    for (const name of Object.keys(body ?? {})) {
      if (name !== "email" && name !== "password") {
        issues.push({
          path: [name],
          message: "Unexpected credential field.",
          code: "unrecognized_key",
        });
      }
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      issues.push({ path: ["email"], message: "Email is invalid.", code: "invalid_email" });
    }
    if (password.length < 4 || password.length > 128) {
      issues.push({
        path: ["password"],
        message: "Password must be between 4 and 128 characters.",
        code: "invalid_length",
      });
    }
    return issues.length
      ? { success: false, issues }
      : { success: true, data: { email, password } };
  },
};

export const authSchema: Schema = {
  jsonSchema: { type: "object" },
  safeParse: (data) => ({ success: true, data }),
};

export function successfulAuthSchema(principal: Schema): Schema {
  return {
    jsonSchema: {
      type: "object",
      required: ["authenticated", "principal", "session", "tenant"],
      properties: {
        authenticated: { const: true },
        principal: principal.jsonSchema,
        session: { type: "null" },
        tenant: { type: "null" },
      },
      additionalProperties: false,
    },
    safeParse(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {
          success: false,
          issues: [
            { path: [], message: "Expected an authentication context.", code: "invalid_type" },
          ],
        };
      }
      const record = value as Record<string, unknown>;
      const parsed = principal.safeParse(record.principal);
      if (!parsed.success) {
        return {
          success: false,
          issues: parsed.issues.map((issue) => ({
            ...issue,
            path: ["principal", ...issue.path],
          })),
        };
      }
      if (record.authenticated !== true || record.session !== null || record.tenant !== null) {
        return {
          success: false,
          issues: [
            {
              path: [],
              message: "Expected a successful authentication context.",
              code: "invalid_value",
            },
          ],
        };
      }
      return { success: true, data: value };
    },
  };
}
